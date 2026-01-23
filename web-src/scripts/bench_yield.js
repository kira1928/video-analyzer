console.log('Running Yield Benchmark...');

async function measure(name, fn) {
  const start = process.hrtime.bigint();
  await fn();
  const end = process.hrtime.bigint();
  const duration = Number(end - start) / 1e6; // ms
  console.log(`${name}: ${duration.toFixed(2)}ms`);
}

async function run() {
  // Baseline: 100ms delay
  await measure('setTimeout(100) [Old]', () => new Promise(r => setTimeout(r, 100)));

  // Optimized: 0ms delay (simulating yieldToMain)
  // Note: yieldToMain uses requestAnimationFrame which is ~16ms max, but in Node we only have setTimeout(0) or setImmediate.
  // We use setTimeout(0) to approximate the minimal delay.
  await measure('setTimeout(0) [New]', () => new Promise(r => setTimeout(r, 0)));
}

run();
