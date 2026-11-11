import { connectHa } from "./ha-api.mjs";

// Only the generated, ownership-checked fixture is eligible for this mutation.
export async function confirmFixtureProxy(path) {
  const deadline = Date.now() + 180_000;
  let configured = false;
  while (Date.now() < deadline) {
    let api;
    try {
      api = await connectHa(path);
      const current = await api.call("http/config");
      const matches = (config) =>
        config?.use_x_forwarded_for &&
        config.trusted_proxies?.includes(api.fixture.network_cidr) &&
        config.trusted_proxies?.includes("127.0.0.1/32");
      if (
        current.active_config_type === "pending" &&
        matches(current.pending)
      ) {
        await api.call("http/config/promote");
        const confirmed = await api.call("http/config");
        if (
          confirmed.active_config_type === "stable" &&
          matches(confirmed.stable)
        )
          return;
      } else if (
        current.active_config_type === "stable" &&
        matches(current.stable)
      )
        return;
      else if (!configured) {
        const config = Object.fromEntries(
          Object.entries(current.stable).filter(
            ([key]) => !["created_at", "error", "error_message"].includes(key),
          ),
        );
        Object.assign(config, {
          use_x_forwarded_for: true,
          trusted_proxies: [api.fixture.network_cidr, "127.0.0.1/32"],
        });
        await api.call("http/config/configure", { config });
        configured = true;
      }
    } catch {
      /* HA restarts while applying a pending HTTP configuration. */
    } finally {
      api?.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error(
    "Generated HA proxy configuration was not confirmed; inspect the owned fixture",
  );
}
