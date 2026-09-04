type Options = {
  url: string;
  users: number;
  requestsPerUser: number;
  key: string;
};

type RequestResult = {
  latency: number;
  status: number;
};

function getOptions(): Options {
  const args = process.argv.slice(2);
  const get = (name: string, fallback: string) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1] ?? fallback;
  };

  return {
    url: get("url", "http://localhost:3000"),
    users: Number(get("users", "1000")),
    requestsPerUser: Number(get("requests", "5")),
    key: get("key", "benchmark")
  };
}

function percentile(values: number[], percentage: number) {
  const index = Math.min(values.length - 1, Math.ceil((percentage / 100) * values.length) - 1);
  return values[index] ?? 0;
}

function formatMilliseconds(value: number) {
  return `${value.toFixed(2)} ms`;
}

async function seedCache(options: Options) {
  const response = await fetch(`${options.url}/cache/${encodeURIComponent(options.key)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: { source: "load-test", createdAt: new Date().toISOString() }, ttlSeconds: 3600 })
  });

  if (!response.ok) {
    throw new Error(`Cache seed failed with status ${response.status}`);
  }
}

async function request(options: Options): Promise<RequestResult> {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${options.url}/cache/${encodeURIComponent(options.key)}`);
    return { latency: performance.now() - startedAt, status: response.status };
  } catch {
    return { latency: performance.now() - startedAt, status: 0 };
  }
}

async function main() {
  const options = getOptions();

  if (!Number.isInteger(options.users) || options.users < 1 || !Number.isInteger(options.requestsPerUser) || options.requestsPerUser < 1) {
    throw new Error("users and requests must be positive integers");
  }

  await seedCache(options);

  const totalRequests = options.users * options.requestsPerUser;
  const results: RequestResult[] = [];
  const startedAt = performance.now();

  await Promise.all(
    Array.from({ length: options.users }, async () => {
      for (let requestNumber = 0; requestNumber < options.requestsPerUser; requestNumber += 1) {
        results.push(await request(options));
      }
    })
  );

  const duration = performance.now() - startedAt;
  const latencies = results.map((result) => result.latency).sort((a, b) => a - b);
  const successful = results.filter((result) => result.status >= 200 && result.status < 300).length;
  const failed = results.length - successful;
  const average = latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length;

  console.log(`URL: ${options.url}`);
  console.log(`Concurrent users: ${options.users}`);
  console.log(`Requests per user: ${options.requestsPerUser}`);
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Duration: ${(duration / 1000).toFixed(2)} s`);
  console.log(`Throughput: ${(totalRequests / (duration / 1000)).toFixed(2)} requests/sec`);
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  console.log(`Min latency: ${formatMilliseconds(latencies[0] ?? 0)}`);
  console.log(`Average latency: ${formatMilliseconds(average)}`);
  console.log(`P50 latency: ${formatMilliseconds(percentile(latencies, 50))}`);
  console.log(`P95 latency: ${formatMilliseconds(percentile(latencies, 95))}`);
  console.log(`P99 latency: ${formatMilliseconds(percentile(latencies, 99))}`);
  console.log(`Max latency: ${formatMilliseconds(latencies[latencies.length - 1] ?? 0)}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
