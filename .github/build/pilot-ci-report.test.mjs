import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyVitestReport } from "../../scripts/pilot-ci-report.mjs";

const file="/repo/packages/example/src/database.integration.test.ts";
const options={root:"/repo",expectedFiles:[file]};
const report=()=>({success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,numFailedTestSuites:0,numPendingTestSuites:0,testResults:[{name:file,status:"passed",assertionResults:[{status:"passed",failureMessages:[],title:"test"}]}]});
test("accepts complete real test coverage and returns only sanitized counts/file names",()=>{
  const input=report();input.privateValue="do-not-export";
  const result=verifyVitestReport(input,options);
  assert.deepEqual(result,{tests:1,passed:1,skipped:0,failed:0,files:[{path:"packages/example/src/database.integration.test.ts",tests:1,passed:1}]});
  assert.ok(!JSON.stringify(result).includes(input.privateValue));
});
test("rejects Vitest success with skipped PostgreSQL tests",()=>{
  const input=report();input.numTotalTests=2;input.numPendingTests=1;input.testResults[0].assertionResults.push({status:"skipped"});
  assert.throws(()=>verifyVitestReport(input,options),/PILOT_CI_SKIPPED_OR_FAILED_TESTS/);
});
test("rejects missing integration files despite otherwise green test counts",()=>{
  assert.throws(()=>verifyVitestReport(report(),{...options,expectedFiles:[file,"/repo/packages/example/src/another.integration.test.ts"]}),/PILOT_CI_TEST_FILE_COVERAGE/);
});
test("rejects todos, hidden skipped assertions and inconsistent aggregate counts",()=>{
  for(const change of [input=>{input.numTodoTests=1;},input=>{input.testResults[0].assertionResults[0].status="skipped";},input=>{input.numPassedTests=2;},input=>{input.numPassedTests=undefined;},input=>{input.success=false;}]){
    const input=report();change(input);assert.throws(()=>verifyVitestReport(input,options));
  }
});
test("empty reports are rejected unless the independent file inventory is empty",()=>{
  const input={...report(),numTotalTests:0,numPassedTests:0,testResults:[]};
  assert.throws(()=>verifyVitestReport(input,options));
  assert.throws(()=>verifyVitestReport(input,{root:"/repo",expectedFiles:[]}));
  assert.deepEqual(verifyVitestReport(input,{root:"/repo",expectedFiles:[],allowEmpty:true}),{tests:0,passed:0,skipped:0,failed:0,files:[]});
});
