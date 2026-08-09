/**
 * Repair records that point at an employee who no longer exists.
 *
 * Every HR record resolves the person's name by populating employee_id — none
 * of them keep a copy of the name. So when an Employee row disappears while
 * the records that reference it survive, those records keep listing, keep
 * their amounts and dates, and show an empty name forever. There is no way to
 * work out who they belonged to after the fact: the id is the only link, and
 * the thing it pointed at is gone.
 *
 * The seed script used to cause exactly this. It wiped the demo tenant's
 * employees and re-created them, which minted new _ids, but it never wiped
 * payroll runs, loans or appraisals. That is fixed in seed.js; this cleans up
 * the damage already done.
 *
 * Two kinds of repair, because the two kinds of reference mean different things:
 *
 *   - A payroll run, loan, appraisal, attendance or leave row IS a record about
 *     one employee. Without that employee it describes nobody. Deleted.
 *   - An asset assignment or a project role merely POINTS at an employee. The
 *     asset and the project are real either way. The reference is cleared.
 *
 * Project time logs are reported but never touched: their hours are already
 * costed into a project, so removing them would silently move project money.
 * Decide those yourself.
 *
 *   Report what is broken (default, changes nothing):
 *     npm run db:fix-orphans
 *
 *   Actually repair it:
 *     npm run db:fix-orphans -- --delete
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./db');
const {
  Employee, PayrollRun, PayrollBatch, EmployeeLoan, Appraisal,
  Attendance, LeaveRequest, Asset, AssetLog, Project, ProjectTask, ProjectTimeLog,
} = require('../models');

const APPLY = process.argv.includes('--delete');

/** Records that exist to describe one employee — meaningless without them. */
const OWNED_BY_EMPLOYEE = [
  ['Payroll runs', PayrollRun, 'employee_id'],
  ['Loans / advances', EmployeeLoan, 'employee_id'],
  ['Appraisals', Appraisal, 'employee_id'],
  ['Attendance', Attendance, 'employee_id'],
  ['Leave requests', LeaveRequest, 'employee_id'],
];

/** Records that merely reference an employee — the record itself stays. */
const REFERENCES_EMPLOYEE = [
  ['Assets (assigned to)', Asset, 'assigned_to'],
  ['Asset log (from)', AssetLog, 'from_employee'],
  ['Asset log (to)', AssetLog, 'to_employee'],
  ['Projects (manager)', Project, 'manager_id'],
  ['Project tasks (assignee)', ProjectTask, 'assignee_id'],
];

/** Ids on `field` that no longer match a live employee. */
async function danglingIds(Model, field, liveIds) {
  const used = await Model.distinct(field);
  return used.filter((id) => id && !liveIds.has(String(id)));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function run() {
  await connectDB();

  const liveIds = new Set((await Employee.find({}, '_id')).map((e) => String(e._id)));
  console.log(`\n${plural(liveIds.size, 'employee')} on file.`);
  console.log(APPLY ? 'Repairing…\n' : 'Dry run — nothing will be changed. Add --delete to repair.\n');

  let broken = 0;

  // ── Records that describe an employee who is gone ─────────────────────────
  const touchedBatches = new Set();

  for (const [label, Model, field] of OWNED_BY_EMPLOYEE) {
    const orphans = await danglingIds(Model, field, liveIds);
    if (!orphans.length) continue;

    const count = await Model.countDocuments({ [field]: { $in: orphans } });
    if (!count) continue;
    broken += count;
    console.log(`  ${label.padEnd(24)} ${plural(count, 'row')} across ${plural(orphans.length, 'missing employee')}`);

    if (!APPLY) continue;
    if (Model === PayrollRun) {
      const runs = await PayrollRun.find({ [field]: { $in: orphans } }, 'batch_id');
      runs.forEach((r) => r.batch_id && touchedBatches.add(String(r.batch_id)));
    }
    await Model.deleteMany({ [field]: { $in: orphans } });
  }

  // ── Records that merely point at one ───────────────────────────────────────
  for (const [label, Model, field] of REFERENCES_EMPLOYEE) {
    const orphans = await danglingIds(Model, field, liveIds);
    if (!orphans.length) continue;

    const count = await Model.countDocuments({ [field]: { $in: orphans } });
    if (!count) continue;
    broken += count;
    console.log(`  ${label.padEnd(24)} ${plural(count, 'row')} — reference cleared, record kept`);

    if (APPLY) await Model.updateMany({ [field]: { $in: orphans } }, { $set: { [field]: null } });
  }

  // Project teams are an array, so the id is pulled out rather than nulled.
  const teamOrphans = await danglingIds(Project, 'team', liveIds);
  if (teamOrphans.length) {
    const count = await Project.countDocuments({ team: { $in: teamOrphans } });
    if (count) {
      broken += count;
      console.log(`  ${'Project teams'.padEnd(24)} ${plural(count, 'project')} — missing members removed`);
      if (APPLY) await Project.updateMany({ team: { $in: teamOrphans } }, { $pull: { team: { $in: teamOrphans } } });
    }
  }

  // ── Payroll batch totals, after runs were removed from under them ─────────
  if (APPLY && touchedBatches.size) {
    for (const batchId of touchedBatches) {
      const runs = await PayrollRun.find({ batch_id: batchId });
      if (!runs.length) {
        await PayrollBatch.deleteOne({ _id: batchId });
        console.log(`  Pay run emptied by the cleanup — removed.`);
        continue;
      }
      const sum = (field) => runs.reduce((t, r) => t + (r[field] || 0), 0);
      await PayrollBatch.updateOne({ _id: batchId }, {
        $set: {
          employee_count:       runs.length,
          total_gross:          sum('gross_salary'),
          total_allowances:     sum('allowances'),
          total_deductions:     sum('deductions'),
          total_paye:           sum('paye'),
          total_ssnit_employee: sum('ssnit_employee'),
          total_ssnit_employer: sum('ssnit_employer'),
          total_net:            sum('net_salary'),
        },
      });
      console.log(`  Pay run retotalled over its ${plural(runs.length, 'remaining payslip')}.`);
    }
  }

  // ── Reported, never touched ───────────────────────────────────────────────
  const logOrphans = await danglingIds(ProjectTimeLog, 'employee_id', liveIds);
  if (logOrphans.length) {
    const count = await ProjectTimeLog.countDocuments({ employee_id: { $in: logOrphans } });
    if (count) {
      console.log(`\n  ${plural(count, 'project time log')} reference a missing employee.`);
      console.log('  Left alone: those hours are already costed into a project, and removing');
      console.log('  them would change what the project appears to have spent.');
    }
  }

  if (!broken) console.log('  Nothing broken. Every reference resolves.');
  else if (!APPLY) console.log(`\n${plural(broken, 'row')} affected. Re-run with --delete to repair.`);
  else console.log(`\nRepaired ${plural(broken, 'row')}.`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
