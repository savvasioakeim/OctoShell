//! The taskbar status dot — the orchestrator's state on the app icon.
//!
//! The UI already says "working" with a pulsing blue node and "finished" with a
//! green one (`blocks/WorkingNode.tsx`, `shell/agentStatus.ts`). This puts the
//! same vocabulary on the taskbar button, so a fanned-out run can be followed
//! without the window in front: it pulses blue while the orchestrator is
//! thinking, settles to a green dot when the turn lands, and goes red when the
//! turn failed. The frontend clears it the moment the window is looked at.
//!
//! ## Platform-specific
//! - **Windows:** `set_overlay_icon` takes an image rather than a number, which
//!   is exactly what we want here; the dot is drawn below and the pulse is a
//!   task swapping frames. The overlay only shows while the window has a
//!   taskbar button.
//! - **macOS:** there is no dock overlay in Tauri, only `set_badge_count`, so a
//!   settled state shows as a badge of 1 and the pulse is skipped. Nothing
//!   animates a dock icon, so this is the honest equivalent rather than a
//!   worse-looking imitation.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Manager};

/// 32px is what Windows asks for at 100% DPI and it scales down cleanly; the
/// dot itself is drawn well inside it so the glow has room.
const SIZE: u32 = 32;

/// How long one breath takes. The in-app node is on Tailwind's `animate-pulse`,
/// which is a two second cycle, and matching it keeps the taskbar and the window
/// saying the same thing at the same speed.
const CYCLE_MS: u64 = 2000;

/// Frames per cycle. The steepest part of the curve moves about 4% of opacity
/// per frame at 40, against 10% every fifth of a second at the 10 this started
/// with, which is what read as pictures being swapped. (A cosine is steeper in
/// the middle than its average, so the step to watch is that peak, not the
/// range divided by the frame count.)
///
/// Cost per frame is one icon built from pre-rendered bytes and one
/// `SetOverlayIcon`, and tao holds the handle in an `Owned<HICON>` that frees
/// itself, so a long turn does not accumulate anything.
const FRAMES: usize = 40;

/// Frame interval, derived so the two above cannot drift apart.
const FRAME_MS: u64 = CYCLE_MS / FRAMES as u64;

/// The dimmest the dot gets, as a fraction of full opacity. Tailwind fades to
/// half; this stops a little short of that because the glow around our dot
/// disappears first and a deeper fade starts to look like a blink.
const PULSE_FLOOR: f32 = 0.45;

/// Opacity of frame `i`, as a cosine so there is no corner anywhere in the
/// loop: full at the start, `PULSE_FLOOR` in the middle, and back to full by
/// the point where it wraps. A hand-written table was what made the old one
/// look stepped, because its slope jumped between entries.
fn pulse_alpha(i: usize) -> f32 {
    let phase = (i % FRAMES) as f32 / FRAMES as f32 * std::f32::consts::TAU;
    let eased = 0.5 + 0.5 * phase.cos(); // 1 at the ends, 0 in the middle
    PULSE_FLOOR + (1.0 - PULSE_FLOOR) * eased
}

/// Bumped on every state change. An animation task reads it each frame and
/// stops as soon as it is no longer the current one, which is what stops the
/// previous pulse when a new state arrives (and avoids two tasks fighting over
/// the icon).
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// The status colours, kept identical to `STATUS_COLOR` in
/// `src/shell/agentStatus.ts`. If those change, change these.
fn colour(state: &str) -> Option<(u8, u8, u8)> {
    match state {
        "working" => Some((0x82, 0xAA, 0xFF)), // blue
        "done" => Some((0x4A, 0xDE, 0x80)),    // green
        "error" => Some((0xF8, 0x71, 0x71)),   // red
        _ => None,
    }
}

/// Draw the dot: a filled circle with a soft glow, at `alpha` overall opacity.
///
/// Antialiasing is done by sampling each pixel on a 3x3 grid and counting how
/// much of it falls inside the circle, which is enough at this size and keeps
/// the whole thing dependency free.
fn draw(rgb: (u8, u8, u8), alpha: f32) -> Vec<u8> {
    let (r, g, b) = rgb;
    let mut px = vec![0u8; (SIZE * SIZE * 4) as usize];
    let c = SIZE as f32 / 2.0;
    // The dot fills most of the tile; the glow fades out over the rest.
    let radius = SIZE as f32 * 0.34;
    let glow = SIZE as f32 * 0.48;

    for y in 0..SIZE {
        for x in 0..SIZE {
            // Coverage of the solid disc, supersampled.
            let mut inside = 0.0f32;
            let mut nearest = f32::MAX;
            for sy in 0..3 {
                for sx in 0..3 {
                    let fx = x as f32 + (sx as f32 + 0.5) / 3.0;
                    let fy = y as f32 + (sy as f32 + 0.5) / 3.0;
                    let d = ((fx - c).powi(2) + (fy - c).powi(2)).sqrt();
                    if d <= radius {
                        inside += 1.0 / 9.0;
                    }
                    nearest = nearest.min(d);
                }
            }
            // Outside the disc, fall off to transparent by the glow radius.
            let a = if inside > 0.0 {
                inside
            } else if nearest < glow {
                let t = (glow - nearest) / (glow - radius);
                // Squared so the halo is subtle rather than a grey ring.
                0.45 * t * t
            } else {
                0.0
            };
            let i = ((y * SIZE + x) * 4) as usize;
            px[i] = r;
            px[i + 1] = g;
            px[i + 2] = b;
            px[i + 3] = (a * alpha * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    px
}

/// Put `rgba` on the taskbar button, or clear it when `None`.
#[cfg(target_os = "windows")]
fn paint(app: &AppHandle, rgba: Option<Vec<u8>>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let image = rgba.map(|px| tauri::image::Image::new_owned(px, SIZE, SIZE));
    let _ = window.set_overlay_icon(image);
}

/// macOS has no dock overlay to paint, only a numeric badge, so a settled state
/// becomes a badge of 1 and anything else clears it.
#[cfg(not(target_os = "windows"))]
fn paint_count(app: &AppHandle, count: Option<i64>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count(count);
    }
}

/// Set the dot: `working` pulses, `done` and `error` settle, anything else
/// clears it. Each call cancels the previous animation.
#[tauri::command]
pub fn badge_set(app: AppHandle, state: String) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let rgb = colour(&state);

    #[cfg(not(target_os = "windows"))]
    {
        // No animation is possible on the dock, so only the settled states show.
        paint_count(&app, if state == "done" || state == "error" { Some(1) } else { None });
        let _ = generation;
        let _ = rgb;
    }

    #[cfg(target_os = "windows")]
    {
        let Some(rgb) = rgb else {
            paint(&app, None);
            return;
        };
        if state != "working" {
            paint(&app, Some(draw(rgb, 1.0)));
            return;
        }
        // Pre-render the loop once. Forty 32x32 buffers is 164KB held for as
        // long as the turn runs, against redrawing a supersampled circle fifteen
        // times a second for minutes on end.
        let frames: Vec<Vec<u8>> = (0..FRAMES).map(|i| draw(rgb, pulse_alpha(i))).collect();
        tauri::async_runtime::spawn(async move {
            let mut i = 0usize;
            loop {
                if GENERATION.load(Ordering::SeqCst) != generation {
                    return; // superseded: whoever replaced us owns the icon now
                }
                paint(&app, Some(frames[i % frames.len()].clone()));
                i += 1;
                tokio::time::sleep(std::time::Duration::from_millis(FRAME_MS)).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The dot is opaque in the middle, soft at its edge and empty in the
    /// corners: the shape the taskbar expects, not a filled square.
    #[test]
    fn draws_a_round_dot() {
        let px = draw((0x82, 0xAA, 0xFF), 1.0);
        assert_eq!(px.len(), (SIZE * SIZE * 4) as usize);
        let at = |x: u32, y: u32| px[((y * SIZE + x) * 4 + 3) as usize];
        let centre = (SIZE / 2, SIZE / 2);
        assert_eq!(at(centre.0, centre.1), 255, "the middle is solid");
        assert_eq!(at(0, 0), 0, "the corners are clear");
        let edge = at(centre.0 + (SIZE as f32 * 0.40) as u32, centre.1);
        assert!(edge > 0 && edge < 255, "the rim fades, got {edge}");
    }

    /// Alpha scales the whole dot, which is what makes the pulse a fade rather
    /// than a blink.
    #[test]
    fn alpha_fades_the_whole_dot() {
        let full = draw((0x4A, 0xDE, 0x80), 1.0);
        let half = draw((0x4A, 0xDE, 0x80), 0.5);
        let i = (((SIZE / 2) * SIZE + SIZE / 2) * 4 + 3) as usize;
        assert_eq!(full[i], 255);
        assert_eq!(half[i], 128);
        // Colour is untouched; only opacity moves.
        assert_eq!(full[i - 3..i], half[i - 3..i]);
    }

    /// The curve has no corner: it starts full, bottoms out in the middle, and
    /// comes back to where it started, so the loop point is invisible. The old
    /// hand-written table failed the last of these.
    #[test]
    fn the_pulse_is_a_smooth_loop() {
        let a: Vec<f32> = (0..FRAMES).map(pulse_alpha).collect();
        assert!((a[0] - 1.0).abs() < 1e-5, "starts at full, got {}", a[0]);
        let lowest = a.iter().cloned().fold(f32::MAX, f32::min);
        assert!((lowest - PULSE_FLOOR).abs() < 1e-3, "bottoms at the floor, got {lowest}");
        // Wrapping back to frame 0 must be no bigger a step than any other.
        let steps: Vec<f32> = (0..FRAMES).map(|i| (pulse_alpha(i + 1) - a[i]).abs()).collect();
        let biggest = steps.iter().cloned().fold(0.0f32, f32::max);
        assert!(biggest < 0.045, "no visible jump, biggest was {biggest}");
    }

    /// An unknown or empty state clears the icon rather than painting something.
    #[test]
    fn unknown_states_have_no_colour() {
        assert!(colour("none").is_none());
        assert!(colour("").is_none());
        assert!(colour("working").is_some());
    }
}
