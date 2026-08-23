//! Benchmark-only in-process coarse display-preparation kernel for Spec 050.13.
//!
//! The stable C ABI deliberately accepts borrowed NumPy buffers and writes into
//! caller-owned output buffers. It gathers the already-selected display rows
//! together with cycle/source projection fields. It is not linked by the
//! application and has no cache, ORM or scientific-identity responsibility.

use rayon::ThreadPool;
use rayon::ThreadPoolBuilder;
use rayon::prelude::*;
use std::sync::OnceLock;

static POOL2: OnceLock<ThreadPool> = OnceLock::new();
static POOL4: OnceLock<ThreadPool> = OnceLock::new();

fn pool(workers: usize) -> Option<&'static ThreadPool> {
    match workers {
        2 => Some(POOL2.get_or_init(|| ThreadPoolBuilder::new().num_threads(2).build().unwrap())),
        4 => Some(POOL4.get_or_init(|| ThreadPoolBuilder::new().num_threads(4).build().unwrap())),
        _ => None,
    }
}

unsafe fn gather_sequential(
    take: &[usize],
    voltage: &[f64],
    time_s: &[f64],
    cycles: &[i64],
    source_index: &[i32],
    out_voltage: *mut f64,
    out_time_s: *mut f64,
    out_cycles: *mut i64,
    out_source_index: *mut i32,
) {
    for (output, &input) in take.iter().enumerate() {
        *out_voltage.add(output) = voltage[input];
        *out_time_s.add(output) = time_s[input];
        *out_cycles.add(output) = cycles[input];
        *out_source_index.add(output) = source_index[input];
    }
}

unsafe fn gather_parallel(
    workers: usize,
    take: &[usize],
    voltage: &[f64],
    time_s: &[f64],
    cycles: &[i64],
    source_index: &[i32],
    out_voltage: *mut f64,
    out_time_s: *mut f64,
    out_cycles: *mut i64,
    out_source_index: *mut i32,
) {
    let Some(thread_pool) = pool(workers) else {
        gather_sequential(
            take,
            voltage,
            time_s,
            cycles,
            source_index,
            out_voltage,
            out_time_s,
            out_cycles,
            out_source_index,
        );
        return;
    };
    // Raw pointers are converted to addresses before entering Rayon so the
    // closure captures only Send/Sync values; writes remain within the caller's
    // disjoint output allocation.
    let voltage_out = out_voltage as usize;
    let time_out = out_time_s as usize;
    let cycles_out = out_cycles as usize;
    let source_out = out_source_index as usize;
    thread_pool.install(|| {
        take.par_iter().enumerate().for_each(|(output, &input)| unsafe {
            *((voltage_out as *mut f64).add(output)) = voltage[input];
            *((time_out as *mut f64).add(output)) = time_s[input];
            *((cycles_out as *mut i64).add(output)) = cycles[input];
            *((source_out as *mut i32).add(output)) = source_index[input];
        });
    });
}

/// Gather an already-selected compact display projection in-process.
///
/// Returns zero for invalid/null buffers or an unsupported worker count, and
/// otherwise returns `take_len`. The caller owns all buffers and guarantees that
/// every take index is in range.
#[no_mangle]
pub unsafe extern "C" fn cx_time_capacity_display_gather(
    take: *const usize,
    take_len: usize,
    voltage: *const f64,
    time_s: *const f64,
    cycles: *const i64,
    source_index: *const i32,
    input_len: usize,
    out_voltage: *mut f64,
    out_time_s: *mut f64,
    out_cycles: *mut i64,
    out_source_index: *mut i32,
    workers: usize,
) -> usize {
    if take.is_null()
        || voltage.is_null()
        || time_s.is_null()
        || cycles.is_null()
        || source_index.is_null()
        || out_voltage.is_null()
        || out_time_s.is_null()
        || out_cycles.is_null()
        || out_source_index.is_null()
        || input_len == 0
        || take_len == 0
        || !matches!(workers, 1 | 2 | 4)
    {
        return 0;
    }
    let take_slice = std::slice::from_raw_parts(take, take_len);
    if take_slice.iter().any(|&index| index >= input_len) {
        return 0;
    }
    let voltage_slice = std::slice::from_raw_parts(voltage, input_len);
    let time_slice = std::slice::from_raw_parts(time_s, input_len);
    let cycles_slice = std::slice::from_raw_parts(cycles, input_len);
    let source_slice = std::slice::from_raw_parts(source_index, input_len);
    if workers == 1 {
        gather_sequential(
            take_slice,
            voltage_slice,
            time_slice,
            cycles_slice,
            source_slice,
            out_voltage,
            out_time_s,
            out_cycles,
            out_source_index,
        );
    } else {
        gather_parallel(
            workers,
            take_slice,
            voltage_slice,
            time_slice,
            cycles_slice,
            source_slice,
            out_voltage,
            out_time_s,
            out_cycles,
            out_source_index,
        );
    }
    take_len
}

/// Coarse display-preparation boundary used by the 050.13 benchmark.
///
/// The loop performs the cycle-range eligibility pass in the native boundary
/// and then gathers the caller's exact, already-parity-checked display take.
/// Keeping the take owned by the benchmark preserves the production envelope
/// rule while ensuring this experiment includes more than a tiny numerical
/// kernel: filtering, validation and final compact field transfer all cross
/// the Python/native boundary in one call.
#[no_mangle]
pub unsafe extern "C" fn cx_time_capacity_display_prepare(
    cycles: *const i64,
    input_len: usize,
    cycle_start: i64,
    cycle_end: i64,
    take: *const usize,
    take_len: usize,
    voltage: *const f64,
    time_s: *const f64,
    source_index: *const i32,
    out_voltage: *mut f64,
    out_time_s: *mut f64,
    out_cycles: *mut i64,
    out_source_index: *mut i32,
    workers: usize,
    eligible_count: *mut usize,
) -> usize {
    if cycles.is_null()
        || take.is_null()
        || voltage.is_null()
        || time_s.is_null()
        || source_index.is_null()
        || out_voltage.is_null()
        || out_time_s.is_null()
        || out_cycles.is_null()
        || out_source_index.is_null()
        || eligible_count.is_null()
        || input_len == 0
        || take_len == 0
        || !matches!(workers, 1 | 2 | 4)
    {
        return 0;
    }
    let cycles_slice = std::slice::from_raw_parts(cycles, input_len);
    let take_slice = std::slice::from_raw_parts(take, take_len);
    let mut eligible = 0usize;
    for &cycle in cycles_slice {
        if cycle >= cycle_start && cycle <= cycle_end {
            eligible += 1;
        }
    }
    *eligible_count = eligible;
    if take_slice.iter().any(|&index| {
        index >= input_len
            || cycles_slice[index] < cycle_start
            || cycles_slice[index] > cycle_end
    }) {
        return 0;
    }
    let voltage_slice = std::slice::from_raw_parts(voltage, input_len);
    let time_slice = std::slice::from_raw_parts(time_s, input_len);
    let source_slice = std::slice::from_raw_parts(source_index, input_len);
    if workers == 1 {
        for (output, &input) in take_slice.iter().enumerate() {
            *out_voltage.add(output) = voltage_slice[input];
            *out_time_s.add(output) = time_slice[input];
            *out_cycles.add(output) = cycles_slice[input];
            *out_source_index.add(output) = source_slice[input];
        }
    } else {
        let Some(thread_pool) = pool(workers) else {
            return 0;
        };
        let voltage_out = out_voltage as usize;
        let time_out = out_time_s as usize;
        let cycles_out = out_cycles as usize;
        let source_out = out_source_index as usize;
        thread_pool.install(|| {
            take_slice.par_iter().enumerate().for_each(|(output, &input)| unsafe {
                *((voltage_out as *mut f64).add(output)) = voltage_slice[input];
                *((time_out as *mut f64).add(output)) = time_slice[input];
                *((cycles_out as *mut i64).add(output)) = cycles_slice[input];
                *((source_out as *mut i32).add(output)) = source_slice[input];
            });
        });
    }
    take_len
}
