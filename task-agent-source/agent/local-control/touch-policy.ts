import {touchZForPressure} from "../../app/touch-pressure";
import type {AgentDevice} from "../general-agent-client";
import type {ScreenHandSemanticAction} from "../action-contract";

/** Manual Normal is the short-tap preset, inside the connected device's
 * advertised limits. The deeper continuous-contact default can turn a click
 * into an unintended long press. No calibration mutation or retry-on-miss. */
export function normalTouchPressure(action:ScreenHandSemanticAction,device:AgentDevice):ScreenHandSemanticAction {
  // A drag needs the driver's separately calibrated continuous-contact pressure.
  // Applying the lighter tap preset to swipes can silently break contact midway.
  if(action.type!=="tap"&&action.type!=="long_press")return action;
  if(action.touchZ!==undefined)return action;
  const profile=device.state?.grbl?.tapProfile;
  if(typeof profile?.minimumTouchZ!=="number"||typeof profile.maximumTouchZ!=="number")return action;
  const touchZ=touchZForPressure("natural",{minimum:profile.minimumTouchZ,maximum:profile.maximumTouchZ});
  return touchZ===null?action:{...action,touchZ};
}
