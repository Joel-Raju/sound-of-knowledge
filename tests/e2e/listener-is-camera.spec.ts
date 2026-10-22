/**
 * §8.9 — "the listener is the camera".
 *
 * **This is the test whose absence let a whole-session bug ship.** The `AudioListener`
 * was never moved in the live path: it sat at the browser default `(0, 0, 0)` facing
 * `(0, 0, -1)` for the entire session while the camera orbited at radius 5.5. The
 * panner positions were always correct in world space, so every offline measurement
 * looked right — the offline harness *does* call `setListener` — and the only symptom
 * was a human reporting "left on both left and right airpods, same with right".
 *
 * Two things are asserted:
 *
 *  1. the listener's pose **tracks the camera** — it is not left at a default;
 *  2. the listener's pose is **not** the browser default while the camera is somewhere
 *     else, which is the specific failure that occurred.
 */
import { expect, test } from "@playwright/test";

interface Pose {
  position: { x: number; y: number; z: number };
  forward: { x: number; y: number; z: number };
}

const readPoses = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const e = window.__sok!.engine as unknown as {
      // `listenerState` is a GETTER that returns the pose — not a method.
      audioEngine?: { listenerState?: Pose };
      visualEngine?: { rig?: { position: { x: number; y: number; z: number } } };
    };
    return {
      listener: e.audioEngine?.listenerState ?? null,
      camera: e.visualEngine?.rig?.position ?? null,
    };
  });

test.describe("§8.9 — the listener is the camera", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?source=synthetic&density=sparse");
    await page.getByTestId("enter-button").click({ timeout: 20_000 });
    await page.getByTestId("hud").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1_200);
  });

  test("the AudioListener is moved onto the camera, not left at the default", async ({ page }) => {
    const { listener, camera } = await readPoses(page);
    expect(listener, "the audio engine must expose its listener pose").not.toBeNull();
    expect(camera, "the rig must expose its position").not.toBeNull();

    // The listener must be AT the camera — not merely somewhere plausible.
    const d = Math.hypot(
      listener!.position.x - camera!.x,
      listener!.position.y - camera!.y,
      listener!.position.z - camera!.z,
    );
    expect(d, "the listener must sit exactly on the camera").toBeLessThan(0.01);

    // And specifically NOT at the browser default `(0, 0, 0)`, which is what the
    // live path left it at for a whole session.
    const fromOrigin = Math.hypot(
      listener!.position.x,
      listener!.position.y,
      listener!.position.z,
    );
    expect(
      fromOrigin,
      "the listener must not be sitting at the browser default origin",
    ).toBeGreaterThan(1);
  });

  test("the listener's forward vector matches the camera's, and rotates with it", async ({ page }) => {
    const first = await readPoses(page);
    // The camera auto-orbits, so the listener's forward must change with it. A listener
    // frozen at a fixed forward is the same bug wearing a different hat.
    await page.waitForTimeout(3_000);
    const second = await readPoses(page);

    const f0 = first.listener!.forward;
    const f1 = second.listener!.forward;
    const changed = Math.hypot(f1.x - f0.x, f1.y - f0.y, f1.z - f0.z);
    expect(changed, "the listener's forward must follow the camera's orbit").toBeGreaterThan(0.01);

    // And the forward must be a unit vector pointing back at the origin, which is where
    // the orb is.
    expect(Math.hypot(f1.x, f1.y, f1.z)).toBeCloseTo(1, 3);
    // Camera is at `c`; forward should be roughly `-normalize(c)`.
    const c = second.camera!;
    const len = Math.hypot(c.x, c.y, c.z) || 1;
    const dot = (f1.x * -c.x + f1.y * -c.y + f1.z * -c.z) / len;
    expect(dot, "forward must point from the camera toward the orb").toBeGreaterThan(0.99);
  });
});
