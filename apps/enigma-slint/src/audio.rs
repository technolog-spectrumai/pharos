//! Voice notes: record from the default microphone and play WAV (16-bit mono), with cpal
//! on desktop. WAV encode / decode (hound) is everywhere; on Android recording and
//! playback are not wired yet (no cpal/oboe in this build) and say so.

use std::io::Cursor;

/// Sample rate of recorded notes (cpal resamples nothing: we take the device's rate).
pub const MAX_SECONDS: u32 = 120;

/// 16-bit mono samples to WAV bytes.
#[must_use]
pub fn wav_bytes(samples: &[i16], rate: u32) -> Vec<u8> {
    let spec = hound::WavSpec { channels: 1, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut out = Cursor::new(Vec::new());
    if let Ok(mut w) = hound::WavWriter::new(&mut out, spec) {
        for s in samples {
            let _ = w.write_sample(*s);
        }
        let _ = w.finalize();
    }
    out.into_inner()
}

/// WAV bytes to (mono i16 samples, rate); stereo is mixed down.
///
/// # Errors
/// Not a WAV.
pub fn wav_samples(wav: &[u8]) -> Result<(Vec<i16>, u32), String> {
    let mut r = hound::WavReader::new(Cursor::new(wav)).map_err(|e| e.to_string())?;
    let spec = r.spec();
    let ch = usize::from(spec.channels.max(1));
    let all: Vec<i16> = match spec.sample_format {
        hound::SampleFormat::Int => r.samples::<i16>().filter_map(Result::ok).collect(),
        hound::SampleFormat::Float => r.samples::<f32>().filter_map(Result::ok).map(|f| (f.clamp(-1.0, 1.0) * 32767.0) as i16).collect(),
    };
    let mono = all.chunks(ch).map(|c| (c.iter().map(|s| i32::from(*s)).sum::<i32>() / ch as i32) as i16).collect();
    Ok((mono, spec.sample_rate))
}

#[cfg(not(target_os = "android"))]
mod imp {
    use std::sync::{Arc, Mutex};

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    /// A recording in progress (drop or [`Recording::stop`] ends it).
    pub struct Recording {
        stream: cpal::Stream,
        buf: Arc<Mutex<Vec<i16>>>,
        rate: u32,
    }

    /// Start recording from the default input.
    ///
    /// # Errors
    /// No microphone, or it would not open.
    pub fn record() -> Result<Recording, String> {
        let dev = cpal::default_host().default_input_device().ok_or("no microphone")?;
        let cfg = dev.default_input_config().map_err(|e| e.to_string())?;
        let rate = cfg.sample_rate().0;
        let ch = usize::from(cfg.channels().max(1));
        let buf = Arc::new(Mutex::new(Vec::new()));
        let max = (rate * super::MAX_SECONDS) as usize;
        let b = buf.clone();
        let push = move |mono: &mut dyn Iterator<Item = i16>| {
            let mut v = b.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            for s in mono {
                if v.len() < max {
                    v.push(s);
                }
            }
        };
        let err = |e| eprintln!("enigma: microphone: {e}");
        let sc: cpal::StreamConfig = cfg.clone().into();
        let stream = match cfg.sample_format() {
            cpal::SampleFormat::F32 => dev.build_input_stream(&sc, move |d: &[f32], _: &_| push(&mut d.chunks(ch).map(|c| (c[0].clamp(-1.0, 1.0) * 32767.0) as i16)), err, None),
            cpal::SampleFormat::I16 => dev.build_input_stream(&sc, move |d: &[i16], _: &_| push(&mut d.chunks(ch).map(|c| c[0])), err, None),
            cpal::SampleFormat::U16 => dev.build_input_stream(&sc, move |d: &[u16], _: &_| push(&mut d.chunks(ch).map(|c| (i32::from(c[0]) - 32768) as i16)), err, None),
            f => return Err(format!("unsupported microphone format {f:?}")),
        }
        .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok(Recording { stream, buf, rate })
    }

    impl Recording {
        /// Stop: the note as WAV.
        #[must_use]
        pub fn stop(self) -> Vec<u8> {
            drop(self.stream);
            let v = self.buf.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
            super::wav_bytes(&v, self.rate)
        }
    }

    /// Play WAV bytes on the default output (in the background).
    ///
    /// # Errors
    /// Not a WAV, no speaker.
    pub fn play(wav: &[u8]) -> Result<(), String> {
        let (samples, rate) = super::wav_samples(wav)?;
        std::thread::spawn(move || {
            let run = || -> Result<(), String> {
                let dev = cpal::default_host().default_output_device().ok_or("no speaker")?;
                let cfg = cpal::StreamConfig { channels: 1, sample_rate: cpal::SampleRate(rate), buffer_size: cpal::BufferSize::Default };
                let secs = samples.len() as f64 / f64::from(rate.max(1));
                let mut it = samples.into_iter();
                let stream = dev
                    .build_output_stream(&cfg, move |d: &mut [f32], _: &_| d.iter_mut().for_each(|s| *s = it.next().map_or(0.0, |v| f32::from(v) / 32768.0)), |e| eprintln!("enigma: speaker: {e}"), None)
                    .map_err(|e| e.to_string())?;
                stream.play().map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_secs_f64(secs + 0.3));
                Ok(())
            };
            if let Err(e) = run() {
                eprintln!("enigma: play: {e}");
            }
        });
        Ok(())
    }
}

#[cfg(target_os = "android")]
mod imp {
    /// Not on Android yet.
    pub struct Recording;
    /// Not on Android yet.
    ///
    /// # Errors
    /// Always.
    pub fn record() -> Result<Recording, String> {
        Err("voice notes are not recorded on Android yet".into())
    }
    impl Recording {
        /// Nothing.
        #[must_use]
        pub fn stop(self) -> Vec<u8> {
            vec![]
        }
    }
    /// Not on Android yet.
    ///
    /// # Errors
    /// Always.
    pub fn play(_wav: &[u8]) -> Result<(), String> {
        Err("voice notes do not play on Android yet".into())
    }
}

pub use imp::{play, record, Recording};

#[cfg(test)]
mod tests {
    #[test]
    fn wav_round_trip() {
        let s: Vec<i16> = (0..1000).map(|i| ((i * 37) % 2000 - 1000) as i16).collect();
        let w = super::wav_bytes(&s, 16_000);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(super::wav_samples(&w).unwrap(), (s, 16_000));
        assert!(super::wav_samples(b"nope").is_err());
    }
}
