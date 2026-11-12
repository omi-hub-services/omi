// Keep the live lifecycle transport limited to sandbox reads and required delivery writes.
export function assertLifecycleApiCall(
  call: { method: string; path: string },
  repository: string,
  workflow: string,
): void {
  const base = `repos/${repository}`;
  const read =
    call.method === "GET" &&
    (call.path === "user" || call.path === base || call.path.startsWith(`${base}/`));
  const write =
    call.path.startsWith(`${base}/`) &&
    ((call.method === "POST" && /\/(issues|pulls|git\/refs|releases)$/.test(call.path)) ||
      (call.method === "POST" &&
        /^issues\/\d+\/comments$/.test(call.path.slice(base.length + 1))) ||
      (call.method === "POST" &&
        call.path === `${base}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`) ||
      (call.method === "PATCH" && /^issues\/\d+$/.test(call.path.slice(base.length + 1))) ||
      (call.method === "PUT" && /^pulls\/\d+\/merge$/.test(call.path.slice(base.length + 1))));
  if (!read && !write) throw new Error("sandbox guard refused API call");
}
