import { expect, it } from "vitest";
import * as watch from "../../../../src/infrastructure/observability/watch-server.js";

it("uses the container interface only for the explicit Docker runtime marker", () => {
  expect(watch.watchBindAddress, "Docker bind selection").toBeTypeOf("function");
  expect(watch.watchBindAddress({})).toBe("127.0.0.1");
  expect(watch.watchBindAddress({ OMI_DOCKER_RUNTIME: "0" })).toBe("127.0.0.1");
  expect(watch.watchBindAddress({ OMI_DOCKER_RUNTIME: "1" })).toBe("0.0.0.0");
});
