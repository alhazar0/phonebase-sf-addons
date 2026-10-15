import { createHeldOutVisualGroundingFixtures } from "./visual-grounding-fixtures";
import { evaluateVisualGrounding } from "./visual-grounding-benchmark";

const report = await evaluateVisualGrounding(
  await createHeldOutVisualGroundingFixtures(),
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.gate.passed) process.exitCode = 1;
