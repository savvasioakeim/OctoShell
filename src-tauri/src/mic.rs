//! Microphone capture for local dictation.
//!
//! The audio is taken here rather than through the webview's `getUserMedia` for
//! two reasons. The webview has already proved it cannot be relied on for
//! speech (its Web Speech API stopped working in WebView2 Runtime 153), and a
//! native device avoids a separate permission prompt in every window — the QA
//! window and the main window are distinct webviews and are asked separately.
//!
//! Recording runs for as long as the user holds the button, so the buffer is
//! bounded by [`MAX_SECONDS`] rather than by trust.

use std::sync::{Arc, Mutex, OnceLock};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::whisper::SAMPLE_RATE;

/// Hard cap on one recording. Whisper processes audio in 30-second windows, and
/// a QA note that runs past five minutes is a mistake rather than an intention;
/// without a cap a forgotten button would grow the buffer until memory ran out.
pub const MAX_SECONDS: usize = 300;

/// Mono f32 samples at the device's own rate, plus that rate, so resampling can
/// happen once at the end instead of per callback.
struct Recording {
    samples: Vec<f32>,
    rate: u32,
    /// Set when the cap is hit, so stopping can say why it is short.
    truncated: bool,
}

/// The live capture. `None` when nothing is recording.
///
/// The stream itself is kept here too: cpal stops a stream when it is dropped,
/// so letting it fall out of scope would silently end the recording the moment
/// the start command returned.
struct Live {
    _stream: cpal::Stream,
    buf: Arc<Mutex<Recording>>,
}

// cpal's Stream is not Send on every host, and this is only ever touched from
// commands on the main thread, so the handle lives behind a mutex that is never
// held across an await.
static LIVE: OnceLock<Mutex<Option<Live>>> = OnceLock::new();

fn live() -> &'static Mutex<Option<Live>> {
    LIVE.get_or_init(|| Mutex::new(None))
}

/// True while a recording is in progress.
pub fn is_recording() -> bool {
    live().lock().map(|l| l.is_some()).unwrap_or(false)
}

/// Open the default input device and start filling a buffer.
pub fn start() -> Result<(), String> {
    let mut slot = live().lock().map_err(|_| "microphone lock poisoned")?;
    if slot.is_some() {
        return Err("already recording".into());
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("no microphone was found")?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("could not read the microphone's settings: {e}"))?;
    let rate = config.sample_rate();
    let channels = config.channels() as usize;
    let cap = MAX_SECONDS * rate as usize;

    let buf = Arc::new(Mutex::new(Recording { samples: Vec::new(), rate, truncated: false }));
    let sink = buf.clone();

    // Downmix in the callback: averaging the channels is cheap, and keeping
    // interleaved stereo around would double the buffer for no gain, since
    // Whisper is mono anyway.
    let push = move |data: &[f32], channels: usize| {
        let Ok(mut rec) = sink.lock() else { return };
        if rec.samples.len() >= cap {
            rec.truncated = true;
            return;
        }
        for frame in data.chunks(channels) {
            let sum: f32 = frame.iter().sum();
            rec.samples.push(sum / channels as f32);
        }
    };

    let err_fn = |e| eprintln!("microphone stream error: {e}");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            config.into(),
            move |d: &[f32], _: &_| push(d, channels),
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            config.into(),
            move |d: &[i16], _: &_| {
                let f: Vec<f32> = d.iter().map(|s| *s as f32 / i16::MAX as f32).collect();
                push(&f, channels)
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            config.into(),
            move |d: &[u16], _: &_| {
                let f: Vec<f32> =
                    d.iter().map(|s| (*s as f32 - u16::MAX as f32 / 2.0) / (u16::MAX as f32 / 2.0)).collect();
                push(&f, channels)
            },
            err_fn,
            None,
        ),
        other => return Err(format!("unsupported microphone sample format: {other:?}")),
    }
    .map_err(|e| format!("could not open the microphone: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("could not start the microphone: {e}"))?;
    *slot = Some(Live { _stream: stream, buf });
    Ok(())
}

/// Stop and hand back the recording as mono f32 at [`SAMPLE_RATE`].
pub fn stop() -> Result<(Vec<f32>, bool), String> {
    let mut slot = live().lock().map_err(|_| "microphone lock poisoned")?;
    let Some(l) = slot.take() else {
        return Err("nothing was recording".into());
    };
    // Dropping the stream stops the device; do it before reading so no callback
    // can append while the buffer is being taken.
    drop(l._stream);
    let rec = l.buf.lock().map_err(|_| "microphone buffer poisoned")?;
    Ok((resample(&rec.samples, rec.rate, SAMPLE_RATE as u32), rec.truncated))
}

/// Linear resampling to Whisper's 16kHz.
///
/// Microphones here run at 44.1k or 48k, so this is always downsampling, and
/// linear interpolation is enough for speech: Whisper's mel front end bins the
/// signal into 80 bands up to 8kHz, which hides interpolation error far below
/// anything that changes a transcript.
fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = (input.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let idx = pos.floor() as usize;
        let frac = (pos - idx as f64) as f32;
        let a = input[idx];
        // The last sample has no successor to interpolate towards.
        let b = *input.get(idx + 1).unwrap_or(&a);
        out.push(a + (b - a) * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::resample;

    /// A 48k → 16k pass must take exactly one sample in three and keep the
    /// signal's shape. Off-by-one here would pitch-shift the audio and quietly
    /// wreck every transcript, with nothing in the output pointing at the cause.
    #[test]
    fn resampling_thirds_the_rate() {
        let input: Vec<f32> = (0..300).map(|i| i as f32).collect();
        let out = resample(&input, 48_000, 16_000);
        assert_eq!(out.len(), 100);
        assert_eq!(out[0], 0.0);
        assert_eq!(out[1], 3.0);
        assert_eq!(out[99], 297.0);
    }

    #[test]
    fn resampling_is_a_no_op_at_the_target_rate() {
        let input = vec![0.1, -0.2, 0.3];
        assert_eq!(resample(&input, 16_000, 16_000), input);
    }

    #[test]
    fn resampling_handles_silence_and_empty_input() {
        assert!(resample(&[], 44_100, 16_000).is_empty());
        assert_eq!(resample(&[0.0; 441], 44_100, 16_000).len(), 160);
    }
}
