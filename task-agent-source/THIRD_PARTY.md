# Third-party foundations

ScreenHand intentionally builds on existing open-source work.

## Protocol and implementation references

- [GRBL](https://github.com/gnea/grbl) — GPL-3.0 License  
  The BACHIN controller runs a GRBL-derived firmware. ScreenHand communicates
  with that firmware over its public serial protocol.
- [Tapster 3](https://github.com/tapsterbot/tapster-3) — MIT License  
  Reference for physical touchscreen tap primitives.
- [Tapster viewport-client](https://github.com/tapsterbot/viewport-client) —
  MIT License  
  Reference for camera-to-robot coordinate calibration.
- [CNCjs](https://github.com/cncjs/cncjs) — MIT License  
  Candidate maintenance and GRBL diagnostic console.
- [Appium](https://github.com/appium/appium) — Apache-2.0 License  
  Reference compatibility layer for existing device-test suites.

No Tapster, CNCjs, or Appium source code has been copied
into the current prototype. Their architectures and public interfaces inform
the product plan. Before commercial distribution, produce a complete software
bill of materials from the lockfile and perform a license/security review.
