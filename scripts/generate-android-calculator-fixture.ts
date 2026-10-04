import * as path from "node:path";
import { validateAndroidCalculatorProject, writeAndroidCalculatorProject } from "../server/agent/androidCalculatorProject";

const output = path.resolve(process.argv[2] || ".tmp/android-calculator-fixture");
writeAndroidCalculatorProject(output, { title: "Jarvis Calculator" });
const errors = validateAndroidCalculatorProject(output);
if (errors.length > 0) throw new Error(errors.join("; "));
console.log(output);
