# Android host setup

An Android host is any Linux, Windows or macOS machine with phones attached
over USB. It runs the **DeviceLab Host Agent**, which talks to the phones
through ADB and streams their screens with **scrcpy-server v3.3.1**.

## 1. Hardware

- Use **powered USB hubs** (USB 3, at least 2.4 A per port). Unpowered hubs
  cause random disconnects and phones that won't charge.
- Plan for **about 10 devices per host** at Medium quality. Each live stream
  costs one encoder on the phone and roughly 1–4 Mbit/s on the LAN.
- Use a wired LAN from the host to the control server. Wi-Fi hosts add latency
  and jitter.
- Keep phones cool and on charge. Turn on "Stay awake while charging" in
  Developer options.

## 2. Install prerequisites

**Ubuntu / Debian** (recommended):

```bash
sudo infra/scripts/bootstrap-android-host.sh      # adb, udev rules, service user
```

**macOS:** `brew install node@20 android-platform-tools`.
**Windows:** install Node 20 and the Android Platform Tools, and add `adb.exe` to `PATH`.

Then, in the agent directory:

```bash
pnpm --filter @devicelab/host-agent build
node apps/host-agent/scripts/fetch-scrcpy-server.mjs   # downloads and checksum-verifies scrcpy-server v3.3.1
```

On an air-gapped host, copy `scrcpy-server-v3.3.1` from a machine with
internet access (SHA-256 `a0f70b20aa4998fbf658c94118cd6c8dab6abbb0647a3bdab344d70bc1ebcbb8`)
and set `scrcpyServerPath` in the config.

A single-binary build is also available: `pnpm --filter @devicelab/host-agent package`
uses `pkg` to produce Linux, macOS and Windows executables.

## 3. Register the host

1. Portal → **Admin → Hosts → Register host**. Give it a name such as `qa-android-rack-01`.
2. Copy the generated `agent.config.json`. The token is shown **once** and the
   server stores only its SHA-256 hash.
3. Save the file as `/etc/devicelab/agent.config.json`, readable only by the
   `devicelab` user (`chmod 600`).

```jsonc
{
  "serverUrl": "https://devicelab.bank.local",
  "agentToken": "dlh_…",
  "hostName": "qa-android-rack-01",
  "adbPath": "adb",
  "allowedSerials": [], // optional allowlist; empty = all attached devices
  "caFile": "/etc/devicelab/internal-ca.pem", // your internal CA, if the server cert isn't publicly trusted
  "healthPort": 4100,
}
```

## 4. Run the agent

```bash
sudo cp infra/scripts/devicelab-agent.service /etc/systemd/system/
sudo systemctl enable --now devicelab-agent
journalctl -u devicelab-agent -f          # JSON logs (pipe through `npx pino-pretty` for humans)
curl -s http://127.0.0.1:4100/health      # local health endpoint
```

The agent:

- watches `adb track-devices` and reports each device's model, OS, screen
  size, battery, temperature and storage, refreshed every 60 s;
- sends a heartbeat every 5 s and reconnects with exponential backoff;
- on a session start, pushes `scrcpy-server.jar`, forwards a local port to
  `localabstract:scrcpy_<id>`, and streams H.264 with no transcoding;
- restarts scrcpy if no frame arrives for 8 s (after first probing with `RESET_VIDEO`);
- installs builds with `pm install -r -g` after checking the SHA-256;
- runs cleanup on release: uninstalls packages installed during the session,
  clears the clipboard, presses Home and optionally reboots
  (`CLEANUP_REBOOT=true` on the server).

## 5. Prepare each phone

1. Settings → About phone → tap **Build number** 7 times to unlock Developer options.
2. Developer options: turn on **USB debugging**, **Stay awake** and
   (Xiaomi/MIUI) **USB debugging (Security settings)**, which is needed for
   input injection.
3. Plug the phone in, unlock it, and accept **"Allow USB debugging?"** with
   _Always allow from this computer_ ticked. Until you do, the portal shows the
   device with a ⚠ "USB debugging not authorised" hint.
4. Put a screen lock with no PIN, or none, on lab devices so sessions don't
   start at a lock screen.
5. Tag devices that hold test SIMs with `test-sim` and record the SIM number
   (Admin → device ⋮ → Edit). OTP bypass in UAT builds is the app team's
   responsibility.

## 6. Apps that can't be captured

Apps that set **FLAG_SECURE** (common in banking apps) render as black frames.
DeviceLab detects this and tells the user to use a UAT/debug build with
FLAG_SECURE disabled. It never weakens production apps. The same applies to
root detection, SSL pinning and device binding: ask the app team for lab builds.

## 7. Troubleshooting

Start with the built-in check. It runs the same steps as a live session and names the one that fails:

```bash
node apps/host-agent/dist/main.js --doctor --config /etc/devicelab/agent.config.json          # all devices
node apps/host-agent/dist/main.js --doctor <serial> --config /etc/devicelab/agent.config.json # one device
```

While a session starts, the portal also shows the current step (pushing scrcpy-server, starting it, waiting for the encoder).

| Problem                             | Check                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device missing                      | `adb devices -l` on the host. Try another cable or port and check the hub's power.                                                                                                                                                                                                                        |
| `unauthorized`                      | Accept the RSA prompt. Otherwise revoke USB debugging authorisations on the phone and replug.                                                                                                                                                                                                             |
| Stream never starts                 | Check that `scrcpyServerPath` exists and is v3.3.1, and look for `scrcpy-server` lines in the agent log.                                                                                                                                                                                                  |
| "agent did not answer stream:start" | The host runs an old agent build or a step is stuck. Rebuild and restart the agent (Admin → Hosts should show agent **0.1.1** or later), then run `--doctor`.                                                                                                                                             |
| `scrcpy-server said: Aborted`       | Android killed the server process at startup. The session error and agent log include the device log lines that explain it; `--doctor` runs a standalone start. Manual check: `adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 3.3.1 list_encoders=true` |
| Touches don't register (Xiaomi)     | Turn on "USB debugging (Security settings)".                                                                                                                                                                                                                                                              |
| Choppy video                        | Lower the quality (Low = 800 px, 1.5 Mbit/s). Check host CPU, USB bandwidth and hub power.                                                                                                                                                                                                                |
