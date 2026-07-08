# Signal K Plugin Quality & Score Optimization Plan

## 1. Fix "Loads" & "Activates" Failures (Target: ~40 points)
The automated checker fails if the plugin crashes or hangs when no hardware is present.

- **Action:** Move plugin metadata (`id`, `name`, `description`, `schema`) outside the main initialization function or ensure it is accessible without environment dependencies.
- **Action:** Guard `plugin.start()` against missing `app` or `options`.
- **Action:** Add a "Safe Mode" check: if the Bluetooth adapter isn't found, the plugin should report a status of "No Bluetooth Adapter Found" instead of throwing an error that crashes the loader.

## 2. Add Plugin Test Suite (Target: ~30 points)
The registry gives a huge boost for having a `tests/` directory.

- **Action:** Install `mocha` and `chai` as dev-dependencies.
- **Action:** Implement "Parser Unit Tests": Create a script that feeds known hex-encoded RaceBox binary packets into the `parseRaceBoxData` function and verifies the resulting Signal K Delta object.
- **Benefit:** This proves the core logic works perfectly without needing a physical device or Bluetooth.

## 3. Security Audit (Target: ~15 points)
The registry runs `npm audit` on every submission.

- **Action:** Update `node-ble` to the latest stable version.
- **Action:** Run `npm audit fix` to resolve sub-dependency vulnerabilities.

## 4. Metadata Enrichment (Target: ~15 points)
Small details in `package.json` that the registry uses for categorization.

- **Action:** Expand `keywords` to include: `racebox`, `imu`, `bluetooth`, `ble`, `waves`, `telemetry`, `navigation`.
- **Action:** Add a `configurationAttributes` section if applicable to help the Appstore display the plugin better.

---

This plan outlines the steps required to increase the Signal K Plugin Registry score from 15/100 to a much higher rating, improving visibility and trust for users.
