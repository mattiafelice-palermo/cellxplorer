//! Isolated Spec 050.10 derivative-kernel benchmark worker.
//!
//! The process deliberately exposes a tiny length-prefixed binary protocol rather
//! than a production Python binding.  Python owns source/cache/request state and
//! sends only numeric segment buffers.  A persistent worker keeps cold module/pool
//! initialization separate from warm request medians while still charging every
//! copy and pipe conversion to the reported boundary.

use rayon::prelude::*;
use rayon::ThreadPool;
use std::env;
use std::io::{self, Read, Write};
use std::time::Instant;

const MAGIC: u32 = 0x4358_0501;
const VERSION: u16 = 1;

#[derive(Clone, Debug)]
struct Segment {
    phase: u8,
    capacity: Vec<f64>,
    voltage: Vec<f64>,
    explicit_cv: Vec<bool>,
}

#[derive(Clone, Debug)]
struct CellInput {
    segments: Vec<Segment>,
}

#[derive(Debug)]
struct SegmentOutput {
    x: Vec<f64>,
    y: Vec<f64>,
}

#[derive(Debug)]
struct CellOutput {
    segments: Vec<SegmentOutput>,
    kernel_ns: u64,
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, count: usize) -> io::Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "frame offset overflow"))?;
        if end > self.bytes.len() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated derivative benchmark frame",
            ));
        }
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    fn u8(&mut self) -> io::Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> io::Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> io::Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn f64_vec(&mut self, count: usize) -> io::Result<Vec<f64>> {
        let bytes = self.take(count.checked_mul(8).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "float buffer size overflow")
        })?)?;
        let mut values = Vec::with_capacity(count);
        for chunk in bytes.chunks_exact(8) {
            values.push(f64::from_le_bytes(chunk.try_into().unwrap()));
        }
        Ok(values)
    }

    fn bool_vec(&mut self, count: usize) -> io::Result<Vec<bool>> {
        Ok(self.take(count)?.iter().map(|value| *value != 0).collect())
    }
}

struct Request {
    mode: u8,
    selected_phase: u8,
    absolute_discharge: bool,
    window: usize,
    cells: Vec<CellInput>,
}

fn parse_request(bytes: &[u8]) -> io::Result<Request> {
    let mut cursor = Cursor::new(bytes);
    if cursor.u32()? != MAGIC || cursor.u16()? != VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported derivative benchmark frame",
        ));
    }
    let mode = cursor.u8()?;
    let selected_phase = cursor.u8()?;
    let absolute_discharge = cursor.u8()? != 0;
    let _reserved = cursor.u8()?;
    let window = cursor.u32()? as usize;
    let cell_count = cursor.u32()? as usize;
    if !matches!(mode, 0 | 1) || window == 0 || cell_count == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid derivative benchmark settings",
        ));
    }

    let mut cells = Vec::with_capacity(cell_count);
    for _ in 0..cell_count {
        let segment_count = cursor.u32()? as usize;
        let mut segments = Vec::with_capacity(segment_count);
        for _ in 0..segment_count {
            let count = cursor.u32()? as usize;
            let phase = cursor.u8()?;
            let _segment_reserved = cursor.take(3)?;
            let capacity = cursor.f64_vec(count)?;
            let voltage = cursor.f64_vec(count)?;
            let explicit_cv = cursor.bool_vec(count)?;
            if capacity.len() != voltage.len() || capacity.len() != explicit_cv.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "derivative segment buffers have different lengths",
                ));
            }
            segments.push(Segment {
                phase,
                capacity,
                voltage,
                explicit_cv,
            });
        }
        cells.push(CellInput { segments });
    }
    if cursor.offset != bytes.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "trailing bytes in derivative benchmark frame",
        ));
    }
    Ok(Request {
        mode,
        selected_phase,
        absolute_discharge,
        window,
        cells,
    })
}

fn rolling_mean(values: &[f64], window: usize, min_periods: usize) -> Vec<f64> {
    let mut output = vec![f64::NAN; values.len()];
    let half = window / 2;
    for index in 0..values.len() {
        let start = index.saturating_sub(half);
        let end = (index + half + 1).min(values.len());
        let mut count = 0usize;
        let mut sum = 0.0f64;
        for value in &values[start..end] {
            if value.is_finite() {
                count += 1;
                sum += *value;
            }
        }
        if count >= min_periods {
            output[index] = sum / count as f64;
        }
    }
    output
}

fn gradient(values: &[f64]) -> Vec<f64> {
    match values.len() {
        0 => Vec::new(),
        1 => vec![f64::NAN],
        2 => vec![values[1] - values[0], values[1] - values[0]],
        count => {
            let mut output = vec![f64::NAN; count];
            output[0] = values[1] - values[0];
            output[count - 1] = values[count - 1] - values[count - 2];
            for index in 1..(count - 1) {
                output[index] = (values[index + 1] - values[index - 1]) / 2.0;
            }
            output
        }
    }
}

fn percentile(values: &[f64], percent: f64) -> f64 {
    let mut finite: Vec<f64> = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect();
    if finite.is_empty() {
        return f64::NAN;
    }
    finite.sort_by(|left, right| left.total_cmp(right));
    if finite.len() == 1 {
        return finite[0];
    }
    let position = (finite.len() - 1) as f64 * (percent / 100.0);
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        finite[lower]
    } else {
        finite[lower] + (finite[upper] - finite[lower]) * (position - lower as f64)
    }
}

fn phase_selected(phase: u8, selected_phase: u8) -> bool {
    matches!(phase, 0 | 1) && (selected_phase == 2 || phase == selected_phase)
}

fn process_segment(
    segment: &Segment,
    mode: u8,
    selected_phase: u8,
    absolute_discharge: bool,
    window: usize,
) -> SegmentOutput {
    let count = segment.capacity.len();
    let mut x = vec![f64::NAN; count];
    let mut y = vec![f64::NAN; count];
    if !phase_selected(segment.phase, selected_phase) {
        return SegmentOutput { x, y };
    }

    let finite_count = segment
        .capacity
        .iter()
        .zip(segment.voltage.iter())
        .filter(|(capacity, voltage)| capacity.is_finite() && voltage.is_finite())
        .count();
    if finite_count < 2 {
        return SegmentOutput { x, y };
    }

    let min_periods = window.min(3).min(finite_count);
    let capacity_smoothed = rolling_mean(&segment.capacity, window, min_periods);
    let voltage_smoothed = rolling_mean(&segment.voltage, window, min_periods);
    let d_capacity = gradient(&capacity_smoothed);
    let d_voltage = gradient(&voltage_smoothed);
    let mut derivative = vec![f64::NAN; count];
    for index in 0..count {
        let numerator = if mode == 0 {
            d_capacity[index]
        } else {
            d_voltage[index]
        };
        let denominator = if mode == 0 {
            d_voltage[index]
        } else {
            d_capacity[index]
        };
        if denominator.abs() >= 1e-10 {
            let value = numerator / denominator;
            if value.is_finite() {
                derivative[index] = value;
            }
        }
    }

    let q_span = percentile(&capacity_smoothed, 95.0) - percentile(&capacity_smoothed, 5.0);
    let v_span = percentile(&voltage_smoothed, 95.0) - percentile(&voltage_smoothed, 5.0);
    let scale = if mode == 0 {
        q_span / v_span.max(1e-9)
    } else {
        v_span / q_span.max(1e-9)
    };
    if scale.is_finite() && scale > 0.0 {
        let limit = scale * 50.0;
        for value in &mut derivative {
            if value.abs() > limit {
                *value = f64::NAN;
            }
        }
    }
    for index in 0..count {
        if segment.explicit_cv[index] {
            derivative[index] = f64::NAN;
        }
        if segment.phase == 1 && absolute_discharge && derivative[index].is_finite() {
            derivative[index] = derivative[index].abs();
        }
        x[index] = if mode == 0 {
            voltage_smoothed[index]
        } else {
            capacity_smoothed[index]
        };
        y[index] = derivative[index];
    }
    SegmentOutput { x, y }
}

fn process_cell(
    cell: &CellInput,
    mode: u8,
    selected_phase: u8,
    absolute_discharge: bool,
    window: usize,
) -> CellOutput {
    let started = Instant::now();
    let segments = cell
        .segments
        .iter()
        .map(|segment| process_segment(segment, mode, selected_phase, absolute_discharge, window))
        .collect();
    CellOutput {
        segments,
        kernel_ns: started.elapsed().as_nanos() as u64,
    }
}

fn response_bytes(
    worker_count: usize,
    pool_init_ns: u64,
    parallel_region_ns: u64,
    kernel_sum_ns: u64,
    outputs: &[CellOutput],
) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&MAGIC.to_le_bytes());
    bytes.extend_from_slice(&VERSION.to_le_bytes());
    bytes.extend_from_slice(&(worker_count as u16).to_le_bytes());
    bytes.extend_from_slice(&(pool_init_ns).to_le_bytes());
    bytes.extend_from_slice(&(parallel_region_ns).to_le_bytes());
    bytes.extend_from_slice(&(kernel_sum_ns).to_le_bytes());
    bytes.extend_from_slice(&(outputs.len() as u32).to_le_bytes());
    for cell in outputs {
        bytes.extend_from_slice(&(cell.segments.len() as u32).to_le_bytes());
        for segment in &cell.segments {
            bytes.extend_from_slice(&(segment.x.len() as u32).to_le_bytes());
            for value in &segment.x {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            for value in &segment.y {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
    }
    bytes
}

fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut length_bytes = [0u8; 4];
    match reader.read_exact(&mut length_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length == 0 || length > 1_000_000_000 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid derivative benchmark frame length",
        ));
    }
    let mut frame = vec![0u8; length];
    reader.read_exact(&mut frame)?;
    Ok(Some(frame))
}

fn parse_workers() -> io::Result<usize> {
    let mut args = env::args().skip(1);
    if args.next().as_deref() != Some("--workers") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected --workers <1|2|4>",
        ));
    }
    let workers = args
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing worker count"))?
        .parse::<usize>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid worker count"))?;
    if !matches!(workers, 1 | 2 | 4) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "worker count must be 1, 2 or 4",
        ));
    }
    Ok(workers)
}

fn main() -> io::Result<()> {
    let worker_count = parse_workers()?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    let mut pool: Option<ThreadPool> = None;

    while let Some(frame) = read_frame(&mut input)? {
        let request = parse_request(&frame)?;
        let mut pool_init_ns = 0u64;
        if pool.is_none() {
            let pool_started = Instant::now();
            pool = Some(
                rayon::ThreadPoolBuilder::new()
                    .num_threads(worker_count)
                    .thread_name(|index| format!("cellxplorer-05010-rayon-{index}"))
                    .build()
                    .map_err(|error| io::Error::other(error.to_string()))?,
            );
            pool_init_ns = pool_started.elapsed().as_nanos() as u64;
        }
        let parallel_started = Instant::now();
        let outputs = pool.as_ref().unwrap().install(|| {
            request
                .cells
                .par_iter()
                .map(|cell| {
                    process_cell(
                        cell,
                        request.mode,
                        request.selected_phase,
                        request.absolute_discharge,
                        request.window,
                    )
                })
                .collect::<Vec<_>>()
        });
        let parallel_region_ns = parallel_started.elapsed().as_nanos() as u64;
        let kernel_sum_ns = outputs.iter().map(|cell| cell.kernel_ns).sum();
        let response = response_bytes(
            worker_count,
            pool_init_ns,
            parallel_region_ns,
            kernel_sum_ns,
            &outputs,
        );
        output.write_all(&(response.len() as u32).to_le_bytes())?;
        output.write_all(&response)?;
        output.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{gradient, rolling_mean};

    #[test]
    fn centered_rolling_matches_linear_values() {
        let actual = rolling_mean(&[0.0, 1.0, 2.0, 3.0, 4.0], 3, 3);
        assert!(actual[0].is_nan());
        assert_eq!(actual[1..4], [1.0, 2.0, 3.0]);
        assert!(actual[4].is_nan());
    }

    #[test]
    fn centered_rolling_ignores_non_finite_values() {
        let actual = rolling_mean(&[0.0, f64::NAN, 2.0, 3.0], 3, 2);
        assert!(actual[0].is_nan());
        assert_eq!(actual[1..], [1.0, 2.5, 2.5]);
    }

    #[test]
    fn gradient_matches_numpy_uniform_spacing() {
        assert_eq!(gradient(&[0.0, 2.0, 4.0, 6.0]), vec![2.0, 2.0, 2.0, 2.0]);
    }
}
