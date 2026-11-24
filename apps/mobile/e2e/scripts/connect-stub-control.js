const action = STUB_ACTION;

const base =
  typeof STUB_CONTROL_URL === "string" && STUB_CONTROL_URL.length > 0
    ? STUB_CONTROL_URL
    : "http://127.0.0.1:42997";

const response = http.post(`${base}/__stub/${action}`, {
  headers: { "content-type": "application/json" },
  body: "{}",
});

if (!response.ok) {
  throw new Error(
    `connect stub ${action} failed: HTTP ${response.status} ${response.body}`,
  );
}

output.stubControl = response.body;
