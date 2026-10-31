// Screen capture for QA Mode: "what I'm pointing at, right now".
//
// A reviewer walking through QA wants to say "this is wrong" about a thing on
// screen, not write a paragraph locating it. One hotkey grabs the monitor the
// pointer is on and hands back TWO files:
//
//   * `full`   — the whole monitor, with a ring drawn where the pointer was.
//   * `detail` — a tight crop around the pointer, same ring.
//
// Both, not either. A 4K frame tells an agent what app and what screen, but the
// pointer is ~20px of it and gets lost; the crop says exactly which control, but
// strips every clue about where it lives. Agents open these by path (QaResult
// .images), so what matters is that each file stands on its own.
//
// Why a hotkey and not a spoken keyword: recognition only settles a word or two
// after you say it, and by then the pointer has moved. The capture has to happen
// on the exact frame you meant.

use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

use image::{Rgba, RgbaImage};

/// One written PNG: the path agents open, and a thumbnail for the UI.
#[derive(Serialize)]
pub struct Shot {
    /// Absolute path on disk. This is what ends up in `QaResult.images`.
    pub path: String,
    /// A small inline `data:` URL of the same image.
    ///
    /// The UI can't read `path` directly: the asset protocol isn't enabled, and
    /// turning it on to render a 56px square would mean a new protocol and a
    /// scope to keep correct. Sending the thumbnail back with the result costs a
    /// few KB over IPC and nothing else.
    pub thumb: String,
}

/// What one capture produced.
#[derive(Serialize)]
pub struct PointerShot {
    /// The full frame first, then the detail crop when there is one.
    pub shots: Vec<Shot>,
    /// Pointer position in the full frame's pixels — lets the UI place its own
    /// marker without redoing any of the DPI mapping below.
    pub x: u32,
    pub y: u32,
    /// Captured monitor size, in the same pixels as `x`/`y`.
    pub width: u32,
    pub height: u32,
}

/// Write `img` as a PNG and pair it with an inline thumbnail.
fn write_shot(img: &RgbaImage, suffix: &str) -> Result<Shot, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::io::Cursor;

    let path = shot_path(suffix)?;
    img.save(&path).map_err(|e| format!("couldn't write the screenshot: {e}"))?;

    // Thumbnail at display size, not full size: the preview is a 56px square.
    let thumb = image::imageops::thumbnail(img, 160, 160 * img.height() / img.width().max(1));
    let mut buf = Cursor::new(Vec::new());
    thumb
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("couldn't encode the thumbnail: {e}"))?;

    Ok(Shot {
        path: path.to_string_lossy().into_owned(),
        thumb: format!("data:image/png;base64,{}", STANDARD.encode(buf.into_inner())),
    })
}

/// Pointer position in **physical** screen pixels.
///
/// The app is per-monitor DPI aware (wry sets this), so GetCursorPos reports
/// physical pixels — the same space DEVMODE reports monitor geometry in, which
/// is what makes the mapping in `capture_pointer` hold at any scale factor. A
/// DPI-unaware process would get virtualised coordinates here and the ring would
/// land off-target on a scaled display.
#[cfg(windows)]
fn cursor_pos() -> Result<(i32, i32), String> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut p = POINT { x: 0, y: 0 };
    // SAFETY: `p` is a live, properly aligned POINT for the duration of the call.
    let ok = unsafe { GetCursorPos(&mut p) };
    if ok == 0 {
        return Err("couldn't read the pointer position".into());
    }
    Ok((p.x, p.y))
}

#[cfg(not(windows))]
fn cursor_pos() -> Result<(i32, i32), String> {
    Err("pointer capture is Windows-only for now".into())
}

/// Draw a ring centred on (cx, cy): a dark outline, a bright core, a dark inner
/// edge. Three bands rather than one because a single colour disappears into a
/// background that happens to match it, and QA runs over arbitrary UIs.
fn draw_ring(img: &mut RgbaImage, cx: i32, cy: i32, radius: i32) {
    const OUTLINE: Rgba<u8> = Rgba([20, 20, 20, 255]);
    const CORE: Rgba<u8> = Rgba([255, 64, 64, 255]);

    let (w, h) = (img.width() as i32, img.height() as i32);
    // Band thickness: outline / core / outline, from the outside in.
    let bands: [(i32, i32, Rgba<u8>); 3] = [
        (radius, radius + 2, OUTLINE),
        (radius - 3, radius, CORE),
        (radius - 5, radius - 3, OUTLINE),
    ];

    for (inner, outer, colour) in bands {
        if outer <= 0 {
            continue;
        }
        let (inner2, outer2) = ((inner.max(0) * inner.max(0)) as i64, (outer * outer) as i64);
        for y in (cy - outer).max(0)..=(cy + outer).min(h - 1) {
            for x in (cx - outer).max(0)..=(cx + outer).min(w - 1) {
                let (dx, dy) = ((x - cx) as i64, (y - cy) as i64);
                let d2 = dx * dx + dy * dy;
                if d2 >= inner2 && d2 <= outer2 {
                    img.put_pixel(x as u32, y as u32, colour);
                }
            }
        }
    }
}

/// A fresh path in the scratch dir shared with dropped files, so QA screenshots
/// are cleaned up by whatever cleans those.
fn shot_path(suffix: &str) -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join("octoshell-drops");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(dir.join(format!("{stamp}-qa-{suffix}.png")))
}

/// Capture the monitor under the pointer and mark where the pointer was.
///
/// `detail_w`/`detail_h` size the crop (defaults 640x400): wide enough to carry
/// the control's neighbours, small enough that the target is unmistakable.
#[tauri::command]
pub fn capture_pointer(detail_w: Option<u32>, detail_h: Option<u32>) -> Result<PointerShot, String> {
    use xcap::Monitor;

    let (cx, cy) = cursor_pos()?;
    let monitor = Monitor::from_point(cx, cy).map_err(|e| format!("no monitor under the pointer: {e}"))?;

    let mut img = monitor.capture_image().map_err(|e| format!("screen capture failed: {e}"))?;
    let (iw, ih) = (img.width(), img.height());
    if iw == 0 || ih == 0 {
        return Err("the capture came back empty".into());
    }

    // Monitor geometry and the pointer are both in physical pixels, so the
    // pointer's offset inside the monitor is a plain subtraction. The ratio
    // guards the one case that would silently misplace the ring: a backend
    // handing back an image whose size isn't the monitor's (scaled or clamped
    // capture). Computing in ratios rather than trusting either number keeps
    // the ring on target even then.
    let mx = monitor.x().map_err(|e| e.to_string())?;
    let my = monitor.y().map_err(|e| e.to_string())?;
    let mw = monitor.width().map_err(|e| e.to_string())?.max(1);
    let mh = monitor.height().map_err(|e| e.to_string())?.max(1);

    let sx = iw as f64 / mw as f64;
    let sy = ih as f64 / mh as f64;
    let px = (((cx - mx) as f64 * sx).round() as i64).clamp(0, iw as i64 - 1) as u32;
    let py = (((cy - my) as f64 * sy).round() as i64).clamp(0, ih as i64 - 1) as u32;

    // Scale the ring with the display so it stays the same apparent size.
    let radius = ((18.0 * sx.max(sy)).round() as i32).clamp(12, 60);
    draw_ring(&mut img, px as i32, py as i32, radius);

    let mut shots = vec![write_shot(&img, "full")?];

    // Crop centred on the pointer, slid (not shrunk) to stay inside the frame:
    // near an edge you want the same amount of context, just off-centre.
    let cw = detail_w.unwrap_or(640).min(iw);
    let ch = detail_h.unwrap_or(400).min(ih);
    if cw < iw || ch < ih {
        let x0 = (px as i64 - cw as i64 / 2).clamp(0, iw as i64 - cw as i64) as u32;
        let y0 = (py as i64 - ch as i64 / 2).clamp(0, ih as i64 - ch as i64) as u32;
        let crop = image::imageops::crop_imm(&img, x0, y0, cw, ch).to_image();
        shots.push(write_shot(&crop, "detail")?);
    }

    Ok(PointerShot {
        shots,
        x: px,
        y: py,
        width: iw,
        height: ih,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Needs a real desktop session (and on Windows, a compositor WGC can read),
    // so it can't run on CI. Kept because it is the only way to catch the silent
    // failure mode: `cargo test --lib -- --ignored shoots_where` then LOOK at the
    // printed path. A correct ring over an all-black frame means the capture
    // backend fell back to GDI.
    #[test]
    #[ignore = "needs a desktop session"]
    fn shoots_where_the_pointer_is() {
        let (cx, cy) = cursor_pos().expect("cursor");
        let m = xcap::Monitor::from_point(cx, cy).expect("monitor");
        println!(
            "cursor=({cx},{cy}) monitor origin=({},{}) size={}x{} scale={}",
            m.x().unwrap(), m.y().unwrap(), m.width().unwrap(), m.height().unwrap(),
            m.scale_factor().unwrap()
        );
        let shot = capture_pointer(None, None).expect("shot");
        println!("image={}x{} pointer=({},{})", shot.width, shot.height, shot.x, shot.y);
        for s in &shot.shots {
            println!("shot={} thumb={}B", s.path, s.thumb.len());
        }

        // The ring must actually be drawn at the reported point.
        let img = image::open(&shot.shots[0].path).expect("reopen").to_rgba8();
        assert_eq!((img.width(), img.height()), (shot.width, shot.height));
        let mut found = false;
        for dy in -40i32..=40 {
            for dx in -40i32..=40 {
                let (x, y) = (shot.x as i32 + dx, shot.y as i32 + dy);
                if x < 0 || y < 0 || x >= img.width() as i32 || y >= img.height() as i32 { continue; }
                let p = img.get_pixel(x as u32, y as u32);
                if p[0] > 200 && p[1] < 100 && p[2] < 100 { found = true; }
            }
        }
        assert!(found, "no marker near the reported pointer position");
    }
}
