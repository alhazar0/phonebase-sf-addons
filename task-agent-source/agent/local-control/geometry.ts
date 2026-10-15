import type { ScreenHandCalibrationProfile } from "../calibration-profile";
import { homographyFromFourPoints, projectPoint, type Point } from "../homography";
import type { LocalView } from "./executor";

export function validateGeometry(profile:ScreenHandCalibrationProfile,view:LocalView) {
  if(profile.verified!==true||profile.deviceId!==view.deviceId)throw new Error("Calibration is unverified or belongs to another device");
  if(profile.frame.width!==view.frame.width||profile.frame.height!==view.frame.height)throw new Error("Raw frame dimensions changed; calibration review required");
  const corners=profile.imagePoints;
  const crosses=corners.map((p,i)=>{const q=corners[(i+1)%4],r=corners[(i+2)%4];return (q.x-p.x)*(r.y-q.y)-(q.y-p.y)*(r.x-q.x);});
  if(!crosses.every(x=>Number.isFinite(x)&&x>1)&&!crosses.every(x=>Number.isFinite(x)&&x< -1))throw new Error("Calibration corners must form a convex ordered quadrilateral");
}
export function cameraToScreen(profile:ScreenHandCalibrationProfile,point:Point):Point {
  const mapped=projectPoint(homographyFromFourPoints(profile.imagePoints,[{x:0,y:0},{x:profile.screen.width,y:0},
    {x:profile.screen.width,y:profile.screen.height},{x:0,y:profile.screen.height}]),point);
  if(!Number.isFinite(mapped.x)||!Number.isFinite(mapped.y)||mapped.x<0||mapped.y<0||mapped.x>profile.screen.width||mapped.y>profile.screen.height)throw new Error("Target lies outside the calibrated screen");
  return mapped;
}
