use video_analyzer::container::{Mp4Container, ContainerReader};
use std::time::Instant;

fn generate_data(size: usize) -> Vec<u8> {
    vec![0u8; size]
}

#[test]
#[ignore]
fn benchmark_allocation() {
    let size = 50 * 1024 * 1024; // 50MB
    let data = generate_data(size);
    let data_slice = &data[..];

    println!("Benchmarking with {} MB data...", size / 1024 / 1024);

    // Baseline: Allocation (Old way)
    let start = Instant::now();
    for _ in 0..10 {
        let data_vec = data_slice.to_vec();
        let _container = Mp4Container::from_bytes(data_vec);
    }
    let duration_baseline = start.elapsed();
    println!("Baseline (to_vec) (10 iterations): {:?}", duration_baseline);
    println!("Baseline average: {:?}", duration_baseline / 10);

    // Optimized: No allocation (New way)
    let start = Instant::now();
    for _ in 0..10 {
        let _container = Mp4Container::from_slice(data_slice);
    }
    let duration_optimized = start.elapsed();
    println!("Optimized (from_slice) (10 iterations): {:?}", duration_optimized);
    println!("Optimized average: {:?}", duration_optimized / 10);

    if duration_optimized < duration_baseline {
        println!("Improvement: {:.2}x faster", duration_baseline.as_nanos() as f64 / duration_optimized.as_nanos() as f64);
    }

    // Verify trait usage compiles
    let mut container = Mp4Container::from_slice(data_slice);
    // This will error at runtime (invalid mp4), but compiles, proving the optimization works for the intended use case.
    let _ = container.read_info();
}
