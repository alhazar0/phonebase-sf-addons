# San Francisco recorder and task-agent supplement

Read `README.md` and `SF-ADDONS-HANDOFF.md` first. This supplement extends the already downloaded `phonebase-sf-handoff`; do not replace its 3020/3013 hardware runtime.

Use `action-recorder` on 3017 and `task-agent-source` for the experimental task backend on 3027 and web UI on 3011/tasks. Port 3027 serves JSON, not the task web page. Only one control plane/driver may own the arm.

Do not run `task-agent-source`'s old `local`, `black`, `fleet`, `control-plane`, `stable`, installers or onboarding. Those are upstream source context, not deployment entry points. Inspect `start-task-ui.sh` before using it; it starts only the task API and UI. Install dependencies separately without importing another machine's runtime state.

Before real execution, verify API/header/frame/calibration/auth compatibility against the current Phonebase 3013 contract. Adapt add-on clients only where necessary, retaining exact frame/viewport, capability and final receipt checks. Do not disable existing authentication to accommodate an old client.

Both 3017 and 3027 are local operator features, not authorized customer gateway endpoints. Do not expose them to the internet. Existing remote customer authorization does not automatically scope these services.

Start with recording without execution and task Preview. Before any Home, motion or replay, get a physically present operator's confirmation of workspace clearance and the bounded action. Do not test by sending messages, publishing content, purchasing or deleting anything. Model-generated plans cannot authorize their own execution. Reuse only newly verified calibration for this device, not donor profiles/alignment files.

One arm must have one active controller: manual Dashboard, recorder, task agent or publishing worker. Do not run them concurrently for a device. Stop, uncertain receipts and crash recovery must fail closed; never auto-resume or silently retry an uncertain physical action.

3027 currently requires a configured planner. Default OpenRouter requires a local private key; Codex provider requires a working local CLI/login and available model. OCR is local Apple Vision, but planner evidence may be sent to the chosen provider. Confirm the intended provider with the user; no copied credentials and no claimed generic model-free autonomy.

Mock test success is not physical acceptance, new-station compatibility, or 11-device qualification. Report actual results separately.
