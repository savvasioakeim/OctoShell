//! Splitting a memory into embeddable pieces.
//!
//! Embedding a whole 4 000-char report as one vector averages every topic in it:
//! it matches a little against everything and strongly against nothing. So we
//! embed small slices and return the surrounding text at recall time
//! (small-to-big retrieval).
//!
//! Splitting is **structural, not fixed-size**: agent reports have real
//! paragraphs (what was done / files / outcome / PR link), and cutting mid
//! sentence produces fragments that embed poorly. We pack whole paragraphs up to
//! a target size, and only fall back to sentence-splitting for a paragraph that
//! is itself too long.

/// Target chunk size. Small enough to stay specific, large enough to carry a
/// complete thought.
const TARGET: usize = 600;
/// A chunk is allowed to overshoot rather than emit a scrap on its own.
const MAX: usize = 900;
/// Trailing text carried into the next chunk so a sentence sitting on a boundary
/// is still fully present in one of them.
const OVERLAP: usize = 90;

/// Provenance prepended to every chunk before embedding.
///
/// A chunk torn out of its document loses who/where/when. Without this, "what
/// happened in ridebly last week" has nothing to match: the word "ridebly"
/// appears nowhere in the body text. We already hold this metadata, so the
/// header costs nothing and recovers the context the split destroyed.
pub fn header(project: &str, branch: Option<&str>, kind: &str, created_at: i64) -> String {
    let date = ymd(created_at);
    match branch {
        Some(b) if !b.is_empty() => format!("[{project} · {b} · {kind} · {date}]"),
        _ => format!("[{project} · {kind} · {date}]"),
    }
}

/// `created_at` (ms since epoch) as `YYYY-MM-DD`, in UTC.
///
/// Done by hand to avoid pulling in a date crate for one format: civil-date
/// conversion from days since 1970 (Howard Hinnant's algorithm).
fn ymd(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Split `text` into chunk bodies (no header — [`header`] is prepended by the
/// caller so the same body can be reused if metadata changes).
pub fn split(text: &str) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    if text.chars().count() <= MAX {
        return vec![text.to_string()];
    }

    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();

    for para in paragraphs(text) {
        for piece in fit(&para) {
            // Would appending overflow? Close the current chunk first.
            if !cur.is_empty() && char_len(&cur) + char_len(&piece) + 2 > MAX {
                let tail = tail_of(&cur, OVERLAP);
                out.push(std::mem::take(&mut cur));
                // Carry the overlap only when the next piece leaves room for it.
                // The size bound is the contract; overlap is an optimisation, and
                // a near-MAX piece (from hard_split) must not push us past it.
                if char_len(&tail) + char_len(&piece) + 2 <= MAX {
                    cur = tail;
                }
            }
            if !cur.is_empty() {
                cur.push_str("\n\n");
            }
            cur.push_str(&piece);
            // At target size we're done accumulating — don't wait for MAX.
            if char_len(&cur) >= TARGET {
                let tail = tail_of(&cur, OVERLAP);
                out.push(std::mem::take(&mut cur));
                cur = tail;
            }
            debug_assert!(char_len(&cur) <= MAX, "working chunk exceeded MAX");
        }
    }
    let last = cur.trim();
    if !last.is_empty() {
        // A trailing scrap that is only the carried-over overlap adds nothing.
        let dup = out.last().map(|p| p.ends_with(last)).unwrap_or(false);
        if !dup {
            out.push(last.to_string());
        }
    }
    out
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

fn paragraphs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            if !cur.trim().is_empty() {
                out.push(cur.trim().to_string());
            }
            cur.clear();
        } else {
            if !cur.is_empty() {
                cur.push('\n');
            }
            cur.push_str(line);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// Break a single oversized paragraph on sentence boundaries. Only reached when
/// one paragraph exceeds MAX on its own (a wall-of-text report).
fn fit(para: &str) -> Vec<String> {
    if char_len(para) <= MAX {
        return vec![para.to_string()];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    for sentence in sentences(para) {
        if !cur.is_empty() && char_len(&cur) + char_len(&sentence) + 1 > MAX {
            out.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(sentence.trim());
        if char_len(&cur) >= TARGET {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    // A single sentence longer than MAX: hard-split it rather than emit a giant
    // chunk that would blow the model's window.
    out.into_iter().flat_map(|s| hard_split(&s)).collect()
}

fn sentences(para: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = para.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        let ends = matches!(c, '.' | '!' | '?' | '\n');
        let next_is_space = chars.get(i + 1).map(|n| n.is_whitespace()).unwrap_or(true);
        if ends && next_is_space && !cur.trim().is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

/// Last resort for a single sentence longer than MAX (minified output, a log
/// line with no punctuation). Cut to leave room for the overlap that [`split`]
/// carries, so the pieces still compose into MAX-bounded chunks instead of
/// forcing the overlap to be dropped.
fn hard_split(s: &str) -> Vec<String> {
    if char_len(s) <= MAX {
        return vec![s.to_string()];
    }
    let width = MAX - OVERLAP - 2;
    s.chars()
        .collect::<Vec<_>>()
        .chunks(width)
        .map(|c| c.iter().collect())
        .collect()
}

/// Last ~`n` chars of `s`, snapped forward to a word boundary so the carried
/// overlap never starts mid-word.
fn tail_of(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        return s.to_string();
    }
    let start = chars.len() - n;
    let slice: String = chars[start..].iter().collect();
    match slice.find(char::is_whitespace) {
        Some(i) => slice[i..].trim_start().to_string(),
        None => slice,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(n: usize, word: &str) -> String {
        std::iter::repeat(word).take(n).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn short_text_stays_one_chunk() {
        let c = split("Fixed the login redirect loop.");
        assert_eq!(c, vec!["Fixed the login redirect loop."]);
    }

    #[test]
    fn empty_text_yields_nothing() {
        assert!(split("   \n\n  ").is_empty());
    }

    #[test]
    fn long_text_splits_and_every_chunk_is_bounded() {
        let text = (0..12).map(|i| para(30, &format!("w{i}"))).collect::<Vec<_>>().join("\n\n");
        let chunks = split(&text);
        assert!(chunks.len() > 1, "should split");
        for c in &chunks {
            assert!(c.chars().count() <= MAX, "chunk over MAX: {}", c.chars().count());
            assert!(!c.trim().is_empty());
        }
    }

    #[test]
    fn splitting_preserves_the_content() {
        // Every source paragraph must survive somewhere — silent data loss here
        // would be invisible until a recall mysteriously missed.
        let text = (0..10).map(|i| para(25, &format!("token{i}"))).collect::<Vec<_>>().join("\n\n");
        let joined = split(&text).join(" ");
        for i in 0..10 {
            assert!(joined.contains(&format!("token{i}")), "lost paragraph {i}");
        }
    }

    #[test]
    fn a_single_giant_sentence_is_still_bounded() {
        let text = para(500, "verylongword");
        for c in split(&text) {
            assert!(c.chars().count() <= MAX);
        }
    }

    #[test]
    fn header_includes_branch_when_present() {
        let h = header("ridebly-fe", Some("qa-dev-574"), "review", 1_753_660_800_000);
        assert!(h.contains("ridebly-fe") && h.contains("qa-dev-574") && h.contains("review"));
        assert!(h.contains("2025-07-28"), "got {h}");
    }

    #[test]
    fn header_omits_empty_branch() {
        let h = header("home", None, "report", 1_753_660_800_000);
        assert!(!h.contains("··"), "got {h}");
        assert_eq!(header("home", Some(""), "report", 1_753_660_800_000), h);
    }

    #[test]
    fn multibyte_text_never_panics() {
        // Greek reports are expected; slicing by bytes would panic mid-codepoint.
        let text = para(400, "αλλαγή");
        for c in split(&text) {
            assert!(c.chars().count() <= MAX);
        }
    }
}
