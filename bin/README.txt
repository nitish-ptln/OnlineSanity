Telephony Manager Sanity Suite v1.0
====================================

This is a standalone diagnostic tool for Telephony Manager sanity testing, now with specialized support for BMW devices.

Quick Start:
-----------
1. Connect your device via USB.
2. Run 'TelephonyManager.exe'.
3. Open your browser to: http://localhost:3000

Features:
---------
- Standalone Executable: No Node.js installation required.
- BMW Integration: Automatically detects 'WAVE' devices and locks to BMW project.
- Dual-SIM Support: Detailed diagnostics for both SIM slots.
- DLT Bridge: Built-in support for DLT logging.

Contents:
---------
- TelephonyManager.exe: The main application (Server + UI).
- adb1.exe: Pre-configured ADB binary to avoid security blocks.

Note:
-----
On first run, the tool will create a 'data' folder to store any customizations or new tests you add.
