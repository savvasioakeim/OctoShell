//! Ranking: turning candidates into the handful that earn prompt space.
//!
//! Retrieval finds what *could* be relevant; ranking decides what actually goes
//! into the orchestrator's limited context. Three ideas, in order:
//!
//! 1. **Fusion** — vector and keyword search fail in opposite places (a vector
//!    search is poor at `qa-dev-574`; FTS is useless for a paraphrase), so we
//!    combine both rankings rather than pick one.
//! 2. **Recency** — in development history, age is a correctness signal, not a
//!    tiebreaker: a two-year-old report about rewritten code is actively
//!    misleading.
//! 3. **Diversity** — five near-identical reports about one bug must not consume
//!    all six slots.

/// Rank position → score, the standard Reciprocal Rank Fusion constant. Damps
/// the top of each list so one confident-but-wrong ranker can't dominate.
const RRF_K: f32 = 60.0;

/// Half-life of the recency weight. At ~30 days a memory carries half the pull
/// of a fresh one — enough to prefer current truth without burying real history.
const HALF_LIFE_DAYS: f32 = 30.0;

/// Relevance vs diversity in [`mmr`]. 0.7 keeps relevance dominant while still
/// rejecting near-duplicates.
const LAMBDA: f32 = 0.7;

const DAY_MS: f32 = 86_400_000.0;

/// One ranked candidate.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub chunk_id: String,
    pub memory_id: String,
    pub project: String,
    pub kind: String,
    pub created_at: i64,
    /// Cosine similarity to the query, when the vector index produced this.
    pub vec_score: f32,
    pub score: f32,
}

/// Fuse a vector ranking and a keyword ranking into one ordered list.
///
/// Takes ranked id lists (best first) rather than raw scores on purpose: cosine
/// similarities and FTS `bm25` values are not on comparable scales, and
/// normalising them against each other invents precision that isn't there.
pub fn fuse(vector_ranked: &[String], keyword_ranked: &[String]) -> Vec<(String, f32)> {
    let mut acc: std::collections::HashMap<&str, f32> = std::collections::HashMap::new();
    for list in [vector_ranked, keyword_ranked] {
        for (i, id) in list.iter().enumerate() {
            *acc.entry(id.as_str()).or_insert(0.0) += 1.0 / (RRF_K + i as f32 + 1.0);
        }
    }
    let mut out: Vec<(String, f32)> = acc.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    // Ties broken by id so ordering is deterministic across runs.
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    out
}

/// Exponential recency weight in (0, 1].
pub fn recency(created_at: i64, now: i64) -> f32 {
    let age_days = ((now - created_at) as f32 / DAY_MS).max(0.0);
    0.5f32.powf(age_days / HALF_LIFE_DAYS)
}

/// Apply recency and project affinity on top of the fused score.
///
/// Multiplicative, not additive: a stale memory should be *discounted*, and an
/// additive bonus would let a large base score ignore age entirely.
pub fn weigh(cands: &mut [Candidate], now: i64, active_project: Option<&str>) {
    for c in cands.iter_mut() {
        let mut w = 0.35 + 0.65 * recency(c.created_at, now);
        if let Some(p) = active_project {
            if !p.is_empty() && c.project.eq_ignore_ascii_case(p) {
                w *= 1.25;
            }
        }
        // A review verdict is a judgement about the work; a dispatch is mostly an
        // echo of what was asked. Weight accordingly.
        w *= match c.kind.as_str() {
            "review" => 1.15,
            "report" => 1.10,
            "dispatch" => 0.85,
            _ => 1.0,
        };
        c.score *= w;
    }
    cands.sort_by(|a, b| {
        b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then(a.chunk_id.cmp(&b.chunk_id))
    });
}

/// Maximal Marginal Relevance: pick `k` items balancing score against novelty.
///
/// `sim(i, j)` gives the similarity between two candidates. Without this step a
/// cluster of near-duplicate reports fills every slot and the recalled context
/// says one thing five times.
pub fn mmr<F>(cands: &[Candidate], k: usize, sim: F) -> Vec<Candidate>
where
    F: Fn(&Candidate, &Candidate) -> f32,
{
    if cands.is_empty() || k == 0 {
        return Vec::new();
    }
    let mut chosen: Vec<Candidate> = Vec::with_capacity(k.min(cands.len()));
    let mut rest: Vec<&Candidate> = cands.iter().collect();

    // Highest scoring item always goes first.
    chosen.push(rest.remove(0).clone());

    while chosen.len() < k && !rest.is_empty() {
        let mut best = 0usize;
        let mut best_val = f32::NEG_INFINITY;
        for (i, c) in rest.iter().enumerate() {
            let max_sim = chosen.iter().map(|s| sim(c, s)).fold(0.0f32, f32::max);
            let val = LAMBDA * c.score - (1.0 - LAMBDA) * max_sim;
            if val > best_val {
                best_val = val;
                best = i;
            }
        }
        chosen.push(rest.remove(best).clone());
    }
    chosen
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: &str, score: f32, age_days: i64, kind: &str) -> Candidate {
        Candidate {
            chunk_id: id.into(),
            memory_id: id.into(),
            project: "p".into(),
            kind: kind.into(),
            created_at: NOW - age_days * 86_400_000,
            vec_score: score,
            score,
        }
    }
    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn fusion_rewards_agreement_between_rankers() {
        // "b" is mid-ranked in both lists; "a" tops one and is absent from the
        // other. Agreement should win — that is the point of fusing.
        let v = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let k = vec!["b".to_string(), "c".to_string(), "d".to_string()];
        let fused = fuse(&v, &k);
        assert_eq!(fused[0].0, "b");
    }

    #[test]
    fn fusion_keeps_items_found_by_only_one_ranker() {
        // An exact branch-name hit lives only in the keyword list; it must survive.
        let fused = fuse(&["a".to_string()], &["qa-dev-574".to_string()]);
        assert!(fused.iter().any(|(id, _)| id == "qa-dev-574"));
    }

    #[test]
    fn recency_decays_by_half_each_half_life() {
        let fresh = recency(NOW, NOW);
        let old = recency(NOW - (HALF_LIFE_DAYS as i64) * 86_400_000, NOW);
        assert!((fresh - 1.0).abs() < 1e-3);
        assert!((old - 0.5).abs() < 0.02, "got {old}");
    }

    #[test]
    fn future_timestamps_do_not_exceed_one() {
        // Clock skew must not manufacture a super-relevant memory.
        assert!(recency(NOW + 86_400_000, NOW) <= 1.0);
    }

    #[test]
    fn a_recent_memory_outranks_an_equally_scored_old_one() {
        let mut c = vec![cand("old", 1.0, 365, "report"), cand("new", 1.0, 1, "report")];
        weigh(&mut c, NOW, None);
        assert_eq!(c[0].chunk_id, "new");
    }

    #[test]
    fn age_cannot_fully_erase_a_strong_match() {
        // The floor (0.35) exists so genuinely old history stays findable.
        let mut c = vec![cand("old", 1.0, 3650, "report")];
        weigh(&mut c, NOW, None);
        assert!(c[0].score > 0.3, "got {}", c[0].score);
    }

    #[test]
    fn mmr_breaks_up_a_cluster_of_duplicates() {
        // Four near-identical items plus one distinct: the distinct one must be
        // pulled into a 2-slot budget instead of a second duplicate.
        let mut cands: Vec<Candidate> =
            (0..4).map(|i| cand(&format!("dup{i}"), 1.0 - i as f32 * 0.01, 1, "report")).collect();
        cands.push(cand("other", 0.90, 1, "report"));
        let picked = mmr(&cands, 2, |a, b| {
            let dup = |c: &Candidate| c.chunk_id.starts_with("dup");
            if dup(a) == dup(b) { 1.0 } else { 0.0 }
        });
        assert_eq!(picked.len(), 2);
        assert_eq!(picked[0].chunk_id, "dup0");
        assert_eq!(picked[1].chunk_id, "other", "MMR should reject the near-duplicate");
    }

    #[test]
    fn mmr_handles_k_larger_than_input() {
        let c = vec![cand("a", 1.0, 1, "report")];
        assert_eq!(mmr(&c, 10, |_, _| 0.0).len(), 1);
        assert!(mmr(&[], 5, |_, _| 0.0).is_empty());
    }
}
