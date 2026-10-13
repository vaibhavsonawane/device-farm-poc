# iOS host setup (macOS only)

> **iOS devices can only be driven from macOS hosts.** The server ignores iOS
> devices reported by Linux or Windows agents. The live iOS driver
> (go-ios + WebDriverAgent) ships in **Phase 2**. This guide covers the
> preparation, so hosts are ready when it does. Until then a macOS agent serves
> its Android devices normally.

## 1. Hardware and OS

- A Mac mini or Mac Studio on wired LAN, macOS 14 or later, with **Xcode**
  matching the newest iOS version you test.
- Powered USB hubs. Up to about 10 iPhones per Mac; WDA uses more CPU than
  scrcpy does.
- **Keep the Mac awake**: `sudo pmset -a sleep 0 displaysleep 0 disksleep 0 autorestart 1`
  (run by `infra/scripts/bootstrap-macos-host.sh`). Turn off automatic macOS updates on lab hosts.

```bash
infra/scripts/bootstrap-macos-host.sh     # node 20, android-platform-tools, go-ios, pmset, launchd plist
```

## 2. Apple developer team and WebDriverAgent signing

WebDriverAgent (WDA) is an XCUITest runner installed on every iPhone. It has
to be signed:

1. Get an Apple Developer **team** (an Enterprise or Organization account is
   recommended for a lab) and a provisioning profile that includes the lab
   device UDIDs. A free personal team works but its profiles expire every 7 days.
2. Clone WebDriverAgent (or use the copy bundled with the Appium XCUITest
   driver) and open `WebDriverAgent.xcodeproj`.
3. For the **WebDriverAgentLib** and **WebDriverAgentRunner** targets, set your
   _Team_ and a unique bundle id, e.g. `in.bank.qa.WebDriverAgentRunner`.
4. Build and install once per device:
   ```bash
   xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner \
     -destination "id=<UDID>" -allowProvisioningUpdates test
   ```
5. Put the runner's bundle id in `agent.config.json` → `wdaBundleId`
   (default `com.facebook.WebDriverAgentRunner.xctrunner`).

## 3. Prepare each iPhone

1. **Trust the computer** when the phone first connects.
2. **Developer Mode** (iOS 16+): Settings → Privacy & Security → Developer Mode → On, then restart.
3. **Trust the developer certificate**: Settings → General → VPN & Device
   Management → _your team_ → Trust. WDA will not launch without this.
4. Settings → Display & Brightness → Auto-Lock → **Never**. Use no passcode on lab devices.
5. Settings → Developer → turn on **Enable UI Automation**.

Check with go-ios:

```bash
ios list                      # UDIDs
ios info --udid <UDID>
ios runwda --udid <UDID> --bundleid <wdaBundleId> --testrunnerbundleid <wdaBundleId> --xctestconfig WebDriverAgentRunner.xctest
```

## 4. How the iOS driver will work (Phase 2)

`IosDriver` implements the same `DeviceDriver` interface as `AndroidDriver`:

| Capability          | Mechanism                                                                          |
| ------------------- | ---------------------------------------------------------------------------------- |
| Discovery           | poll `ios list --details`                                                          |
| Start session       | `ios runwda`, then `ios forward 8100` (WDA HTTP) and `9100` (MJPEG)                |
| Screen              | WDA MJPEG stream → `MJPEG_FRAME` protocol frames (the portal already renders them) |
| Input               | `/wda/tap`, `/wda/dragfromtoforduration`, `/wda/keys`, `/wda/pressButton`          |
| Install / uninstall | `ios install --path`, `ios uninstall`                                              |
| Logs                | `ios syslog` → `session:log`                                                       |
| Screenshot          | `ios screenshot`                                                                   |
| Location            | `ios setlocation` (Phase 4)                                                        |

## 5. Troubleshooting

| Problem                 | Fix                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **WDA signing failure** | Check the Team on both WDA targets, that the provisioning profile contains the UDID, and the unique bundle id. Open Xcode once and accept the licence. |
| "Untrusted Developer"   | Trust the certificate on the phone (step 3.3).                                                                                                         |
| WDA starts then dies    | Developer Mode is off or the phone locked. Check Auto-Lock is Never and the cable is solid.                                                            |
| Device not listed       | Unlock it and tap "Trust", then check `ios list`. Try another port. Avoid unpowered hubs.                                                              |
| Mac slept overnight     | Re-run the `pmset` command, and check Energy settings and screen savers.                                                                               |
