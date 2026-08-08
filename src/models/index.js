const mongoose = require('mongoose');
const { Schema } = mongoose;

// TENANT
const tenantSchema = new Schema({
  business_name:           { type: String, required: true },
  slug:                    { type: String, required: true, unique: true, lowercase: true },
  email:                   { type: String, required: true, unique: true, lowercase: true },
  phone:                   String,
  address:                 String,
  logo:                    String,
  plan:                    { type: String, enum: ['starter','pro','enterprise','custom'], default: 'starter' },
  subscription_status:     { type: String, enum: ['trial','active','expired','suspended'], default: 'trial' },
  subscription_expires_at: { type: Date, default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) },
  subscription_type:       { type: String, enum: ['plan','custom'], default: 'plan' },
  modules:                 { type: [String], default: [] },
  addons:                  { type: [String], default: [] },
  max_branches:            { type: Number, default: 1 },
  max_users:               { type: Number, default: 5 },
  is_active:               { type: Boolean, default: true },
  card_saved:              { type: Boolean, default: false },
  trial_ends_at:           Date,
  auto_renew:              { type: Boolean, default: true },
  trial_warning_sent:      { type: Boolean, default: false },
  // Statutory payroll deductions — some tenants (informal/non-registered
  // employers, contractor-only shops) don't run formal SSNIT/PAYE. Lets a
  // business owner turn either off; payroll then computes gross-to-net
  // without that deduction.
  payroll_settings: {
    apply_ssnit: { type: Boolean, default: true },
    apply_paye:  { type: Boolean, default: true },
  },
  attendance_settings: {
    standard_hours_per_day: { type: Number, default: 8 },
    // Used to turn a monthly salary into an hourly cost when allocating
    // attended time to projects. 26 is the common Ghanaian convention.
    working_days_per_month: { type: Number, default: 26 },
    // What an overtime hour costs relative to a normal one.
    overtime_multiplier:    { type: Number, default: 1.5 },
  },
  storefront_settings: {
    delivery_fee:              { type: Number, default: 30 },
    free_delivery_threshold:   { type: Number, default: 500 },
    store_enabled:             { type: Boolean, default: true },
    announcement:              { type: String, default: '' },
    min_order_amount:          { type: Number, default: 0 },
    custom_domain:             { type: String, default: '', lowercase: true, trim: true },
    tax_rate:                  { type: Number, default: 0 },
    tax_name:                  { type: String, default: 'Tax' },
  },
  // Prepaid SMS credits. One credit is one message segment; sending is blocked
  // at zero. Bought from the platform in bundles (PlatformSettings.sms_bundles)
  // and only ever moved by smsService, atomically.
  sms_credits: { type: Number, default: 0, min: 0 },
  sms_settings: {
    // Shown as the message sender. Falls back to the platform default.
    sender_id:        { type: String, default: '' },
    // Per-event switches live on the templates themselves; this is the master.
    enabled:          { type: Boolean, default: true },
    low_balance_at:   { type: Number, default: 20 },
  },
  // Paystack subaccount. When set, storefront payments are split at the
  // gateway: the tenant's share settles directly to their own bank account and
  // only the platform's commission reaches the platform account. Tenants
  // without one keep collecting into the platform balance and withdrawing from
  // it (see payoutService).
  paystack_subaccount: {
    subaccount_code: String,
    account_number:  String,
    account_name:    String,
    bank_code:       String,
    is_active:       { type: Boolean, default: false },
    connected_at:    Date,
  },
  payout_settings: {
    // When false (default) takings accumulate as a withdrawable balance and a
    // business owner / branch manager requests payouts on demand. When true,
    // each paid order is transferred out immediately on fulfillment — the
    // original behaviour, kept as an opt-in.
    auto_payout:        { type: Boolean, default: false },
    // When false a single organisation-wide payout method serves every branch.
    // When true each branch keeps its own method and branch payouts go there,
    // falling back to the org-wide default if a branch has not set one up.
    per_branch_methods: { type: Boolean, default: false },
    // Smallest amount that may be withdrawn in one request.
    min_payout_amount:  { type: Number, default: 10 },
  },
}, { timestamps: true });

// BRANCH
const branchSchema = new Schema({
  tenant_id:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:       { type: String, required: true },
  address:    String,
  phone:      String,
  email:      String,
  manager_id: { type: Schema.Types.ObjectId, ref: 'User' },
  slug:       { type: String, required: true },
  is_active:  { type: Boolean, default: true },
}, { timestamps: true });
branchSchema.index({ tenant_id: 1, slug: 1 }, { unique: true });

// USER
const userSchema = new Schema({
  tenant_id:            { type: Schema.Types.ObjectId, ref: 'Tenant' },
  branch_id:            { type: Schema.Types.ObjectId, ref: 'Branch' },
  name:                 { type: String, required: true },
  email:                { type: String, required: true, unique: true, lowercase: true },
  password_hash:        { type: String, required: true },
  role:                 { type: String, enum: [
    'platform_admin',
    'business_owner',
    'branch_manager',
    'sales_staff',
    'warehouse_staff',
    'accountant',
    'hr_manager',
    'procurement_officer',
    'employee',
    'custom',
  ], default: 'sales_staff' },
  custom_role_id:       { type: Schema.Types.ObjectId, ref: 'Role' },
  is_active:            { type: Boolean, default: true },
  token_version:        { type: Number, default: 0 },
  verification_id:      String,
  verification_code:    String,
  verification_expires: Date,
}, { timestamps: true });
userSchema.index({ tenant_id: 1, email: 1 });

// CATEGORY
const categoryFieldSchema = new Schema({
  label:    { type: String, required: true },
  key:      { type: String, required: true },   // snake_case identifier
  type:     { type: String, enum: ['text','number','select','boolean'], default: 'text' },
  options:  [String],                            // for select type
  required: { type: Boolean, default: false },
}, { _id: false });

const categorySchema = new Schema({
  tenant_id:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:          { type: String, required: true },
  description:   String,
  scope:         { type: String, enum: ['product', 'service'], default: 'product' },
  custom_fields: { type: [categoryFieldSchema], default: [] },
}, { timestamps: true });
categorySchema.index({ tenant_id: 1, name: 1 }, { unique: true });

// BUNDLE COMPONENT — one line inside a bundle's composition
const bundleItemSchema = new Schema({
  product_id: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  quantity:   { type: Number, required: true, min: 1, default: 1 },
}, { _id: false });

// PRODUCT / SERVICE / BUNDLE CATALOG ITEM
// item_type drives behaviour throughout the system:
//   'product' — physical item, stock tracked, deducted on sale
//   'service' — intangible, no stock, no stock movements, billed by time/unit
//   'bundle'  — a named package of products + services sold together
const productSchema = new Schema({
  tenant_id:           { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:           { type: Schema.Types.ObjectId, ref: 'Branch' },
  name:                { type: String, required: true },
  sku:                 { type: String, sparse: true },
  barcode:             { type: String, sparse: true },
  description:         String,
  category_id:         { type: Schema.Types.ObjectId, ref: 'Category' },
  // --- catalog type ---
  item_type:           { type: String, enum: ['product', 'service', 'bundle'], default: 'product' },
  // --- service-specific fields (ignored for products) ---
  // How the service is billed: per hour, per day, as a fixed fee, or per unit
  unit_type:           { type: String, enum: ['hour', 'day', 'fixed', 'unit'], default: 'fixed' },
  // Estimated duration (e.g. 2 hours, 3 days). Informational only.
  duration:            { type: Number, default: null },
  // GL revenue account to post to. Defaults to 4001 (Sales Revenue) for
  // products and 4010 (Service Revenue) for services when not set.
  revenue_account_code: { type: String, default: null },
  // --- pricing ---
  // 'fixed'  — the catalog price is what is charged, always.
  // 'open'   — no set price; whoever rings it up enters the amount (repairs,
  //            quotes, bespoke jobs). The server only honours a price sent by
  //            the client for items marked this way — everything else is priced
  //            server-side, so a tampered client cannot change what is charged.
  pricing_mode:        { type: String, enum: ['fixed', 'open'], default: 'fixed' },
  // Optional bounds for open pricing, so a mistyped amount can't ring up as
  // GHS 5 instead of GHS 500. Zero means unbounded.
  min_price:           { type: Number, default: 0 },
  max_price:           { type: Number, default: 0 },
  price:               { type: Number, required: true, default: 0 },
  compare_price:       { type: Number, default: 0 },
  cost_price:          { type: Number, default: 0 },
  // --- inventory (products only, ignored for services/bundles) ---
  stock_qty:           { type: Number, default: 0 },
  reserved_qty:        { type: Number, default: 0 },
  low_stock_threshold: { type: Number, default: 10 },
  unit:                { type: String, default: 'piece' },
  images:              [String],
  attributes:          { type: Schema.Types.Mixed, default: {} },
  // --- bundle composition (bundle only, ignored for products/services) ---
  bundle_items:        { type: [bundleItemSchema], default: [] },
  location_id:         { type: Schema.Types.ObjectId, ref: 'StorageLocation' },
  is_active:           { type: Boolean, default: true },
  created_by:          { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
productSchema.index({ tenant_id: 1, sku: 1 }, { unique: true, sparse: true });
productSchema.index({ tenant_id: 1, item_type: 1, is_active: 1 });

// STOCK MOVEMENT
const stockMovementSchema = new Schema({
  tenant_id:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:  { type: Schema.Types.ObjectId, ref: 'Branch' },
  product_id: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  type:       { type: String, enum: ['sale','purchase','adjustment','return'], required: true },
  quantity:   { type: Number, required: true },
  reference:  String,
  notes:      String,
  created_by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// CUSTOMER
const customerSchema = new Schema({
  tenant_id:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:  { type: Schema.Types.ObjectId, ref: 'Branch' },
  name:       { type: String, required: true },
  email:      String,
  phone:      String,
  company:    String,
  address:    String,
  segment:    { type: String, default: 'general' },
  notes:      String,
  created_by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// LEAD
const leadSchema = new Schema({
  tenant_id:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:     { type: Schema.Types.ObjectId, ref: 'Branch' },
  customer_id:   { type: Schema.Types.ObjectId, ref: 'Customer' },
  title:         { type: String, required: true },
  stage:         { type: String, enum: ['new','contacted','qualified','proposal','negotiation','won','lost'], default: 'new' },
  value:         { type: Number, default: 0 },
  assigned_to:   { type: Schema.Types.ObjectId, ref: 'User' },
  next_followup: Date,
  notes:         String,
}, { timestamps: true });

// CONTACT HISTORY
const contactHistorySchema = new Schema({
  tenant_id:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:    { type: Schema.Types.ObjectId, ref: 'Branch' },
  customer_id:  { type: Schema.Types.ObjectId, ref: 'Customer' },
  type:         { type: String, enum: ['call','email','meeting','whatsapp','other'], default: 'call' },
  notes:        String,
  contact_date: { type: Date, default: Date.now },
  created_by:   { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// ORDER
const orderItemSchema = new Schema({
  product_id:   { type: Schema.Types.ObjectId, ref: 'Product' },
  product_name: { type: String, required: true },
  quantity:     { type: Number, required: true },
  unit_price:   { type: Number, required: true },
  total:        { type: Number, required: true },
  refunded_qty: { type: Number, default: 0 },
  // Snapshot of the catalog item type at the time of sale so fulfillment
  // logic knows whether to deduct stock without re-fetching the product.
  item_type:    { type: String, enum: ['product', 'service', 'bundle'], default: 'product' },
  // For services: the GL revenue account code to post to (e.g. '4010').
  // Null means fall back to the default for the item_type.
  revenue_account_code: { type: String, default: null },
});

const orderSchema = new Schema({
  tenant_id:        { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:        { type: Schema.Types.ObjectId, ref: 'Branch' },
  order_number:     { type: String, required: true },
  customer_id:      { type: Schema.Types.ObjectId, ref: 'Customer' },
  customer_name:    { type: String, required: true },
  customer_email:   String,
  customer_phone:   String,
  delivery_address: String,
  subtotal:         { type: Number, default: 0 },
  tax_amount:       { type: Number, default: 0 },
  total:            { type: Number, default: 0 },
  payment_ref:      String,
  payment_method:   String,
  paystack_checkout_url: String,
  pending_expires_at:    Date,
  payment_failure_reason: String,
  payment_status:   { type: String, enum: ['pending','paid','failed','refunded'], default: 'pending' },
  // Product orders:  pending → processing → shipped → delivered
  // Service orders:  pending → in_progress → completed
  // Either type:     → cancelled
  status:           { type: String, enum: ['pending','processing','in_progress','shipped','delivered','completed','cancelled'], default: 'pending' },
  source:           { type: String, enum: ['storefront','internal','pos'], default: 'storefront' },
  // Order was placed via the cross-tenant marketplace directory rather than
  // a direct visit to the tenant's own storefront URL — the platform takes
  // a commission (platform_fee) out of the payout for these.
  via_marketplace:  { type: Boolean, default: false },
  platform_fee:     { type: Number, default: 0 },
  // Paystack actually collected this money, whichever channel it arrived on.
  // POS records payment_method as the channel the customer used ('momo',
  // 'card'), which does not say whether the funds reached Paystack — a MoMo
  // transfer straight to the shop looks identical. This flag is what the
  // withdrawable balance keys off, so takings can't be missed or invented.
  paystack_settled: { type: Boolean, default: false },
  // Paid through a Paystack split — the tenant's share went straight to their
  // own subaccount and never reached the platform balance. These orders are
  // excluded from the withdrawable balance so they can't be paid out twice.
  split_settled:    { type: Boolean, default: false },
  subaccount_code:  String,
  refund_amount:    { type: Number, default: 0 },
  discount_amount:  { type: Number, default: 0 },
  coupon_code:      String,
  shift_id:         { type: Schema.Types.ObjectId, ref: 'PosShift' },
  items:            [orderItemSchema],
  created_by:       { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
orderSchema.index({ tenant_id: 1, order_number: 1 }, { unique: true });

// SUPPLIER
const supplierSchema = new Schema({
  tenant_id:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:          { type: String, required: true },
  email:         String,
  phone:         String,
  address:       String,
  payment_terms: String,
  notes:         String,
  is_active:     { type: Boolean, default: true },
}, { timestamps: true });

// PURCHASE ORDER
const poItemSchema = new Schema({
  product_id:        { type: Schema.Types.ObjectId, ref: 'Product' },
  product_name:      { type: String, required: true },
  quantity_ordered:  { type: Number, required: true },
  quantity_received: { type: Number, default: 0 },
  unit_cost:         { type: Number, required: true },
  total:             { type: Number, required: true },
});

const purchaseOrderSchema = new Schema({
  tenant_id:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:      { type: Schema.Types.ObjectId, ref: 'Branch' },
  po_number:      { type: String, required: true },
  supplier_id:    { type: Schema.Types.ObjectId, ref: 'Supplier' },
  total_cost:     { type: Number, default: 0 },
  amount_paid:    { type: Number, default: 0 },
  status:         { type: String, enum: ['draft','pending_approval','approved','sent','partially_received','completed','cancelled'], default: 'draft' },
  payment_status: { type: String, enum: ['unpaid','partial','paid'], default: 'unpaid' },
  payments:       [{ amount: Number, method: String, reference: String, note: String, date: { type: Date, default: Date.now } }],
  paid_at:        Date,
  project_id:     { type: Schema.Types.ObjectId, ref: 'Project' },
  notes:          String,
  expected_date:  Date,
  items:          [poItemSchema],
  created_by:     { type: Schema.Types.ObjectId, ref: 'User' },
  approved_by:    { type: Schema.Types.ObjectId, ref: 'User' },
  approved_at:    Date,
}, { timestamps: true });
purchaseOrderSchema.index({ tenant_id: 1, po_number: 1 }, { unique: true });

// ACCOUNT
const accountSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  code:        { type: String, required: true },
  name:        { type: String, required: true },
  type:        { type: String, enum: ['asset','liability','equity','revenue','expense'], required: true },
  // balance field removed — balances are computed live from journal entries (GL source of truth)
  description: String,
  is_active:   { type: Boolean, default: true },
  // Hierarchy
  parent_id:   { type: Schema.Types.ObjectId, ref: 'Account', default: null },
  level:       { type: Number, default: 1 },   // 1 = group header, 2 = sub-group, 3 = posting account
  is_group:    { type: Boolean, default: false }, // group accounts cannot be posted to directly
}, { timestamps: true });
accountSchema.index({ tenant_id: 1, code: 1 }, { unique: true });

// JOURNAL ENTRY
const journalLineSchema = new Schema({
  account_id:  { type: Schema.Types.ObjectId, ref: 'Account' },
  debit:       { type: Number, default: 0 },
  credit:      { type: Number, default: 0 },
  description: String,
});

const journalEntrySchema = new Schema({
  tenant_id:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  reference:    { type: String, required: true },
  description:  { type: String, required: true },
  total_debit:  { type: Number, default: 0 },
  total_credit: { type: Number, default: 0 },
  source:       { type: String, enum: ['manual','sale','purchase','payroll','expense','vendor_bill'], default: 'manual' },
  source_id:    Schema.Types.ObjectId,
  entry_date:   { type: Date, default: Date.now },
  lines:        [journalLineSchema],
  created_by:   { type: Schema.Types.ObjectId, ref: 'User' },
  // Immutability & audit
  status:       { type: String, enum: ['posted','voided'], default: 'posted' },
  voided_by:    { type: Schema.Types.ObjectId, ref: 'User' },
  voided_at:    Date,
  void_reason:  String,
}, { timestamps: true });
journalEntrySchema.index({ tenant_id: 1, reference: 1 }, { unique: true });
// Performance indexes for GL aggregation queries used by all financial reports
journalEntrySchema.index({ tenant_id: 1, status: 1, entry_date: -1 });
journalEntrySchema.index({ tenant_id: 1, 'lines.account_id': 1, status: 1 });
journalEntrySchema.index({ tenant_id: 1, source: 1, source_id: 1 });

// EXPENSE
const expenseSchema = new Schema({
  tenant_id:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:    { type: Schema.Types.ObjectId, ref: 'Branch' },
  title:        { type: String, required: true },
  category:     String,
  amount:       { type: Number, required: true },
  account_id:   { type: Schema.Types.ObjectId, ref: 'Account' },
  description:  String,
  expense_date: { type: Date, default: Date.now },
  receipt:           { file: String, mime_type: String, name: String },
  // Set when this belongs to a project, so project cost is read off the
  // records already kept rather than a parallel ledger that drifts.
  project_id:   { type: Schema.Types.ObjectId, ref: 'Project' },
  journal_entry_id:  { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  created_by:        { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// DEPARTMENT
const departmentSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:        { type: String, required: true },
  description: String,
}, { timestamps: true });
departmentSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

// EMPLOYEE
const employeeSchema = new Schema({
  tenant_id:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:     { type: Schema.Types.ObjectId, ref: 'Branch' },
  user_id:       { type: Schema.Types.ObjectId, ref: 'User' },
  manager_id:    { type: Schema.Types.ObjectId, ref: 'Employee' },
  employee_code: { type: String, required: true },
  name:          { type: String, required: true },
  email:         String,
  phone:         String,
  department_id: { type: Schema.Types.ObjectId, ref: 'Department' },
  job_title:     String,
  gross_salary:  { type: Number, required: true, default: 0 },
  // What an hour of this person's time costs a project. Left at zero it is
  // derived from the monthly salary, which is right for salaried staff; set it
  // directly for day labour and subcontracted trades, whose cost has nothing
  // to do with a monthly figure.
  hourly_rate:   { type: Number, default: 0, min: 0 },
  start_date:    Date,
  end_date:      Date,
  termination_reason: String,
  status:        { type: String, enum: ['active','on_leave','terminated'], default: 'active' },
  // Legacy annual/sick fields — superseded by leave_entitlements below, kept
  // for backward compatibility (used as a fallback when an employee has no
  // leave_entitlements entry yet for 'annual'/'sick').
  annual_leave_entitlement: { type: Number, default: 21 },
  sick_leave_entitlement:   { type: Number, default: 10 },
  leave_balances: {
    annual_used: { type: Number, default: 0 },
    sick_used:   { type: Number, default: 0 },
  },
  // Per leave-type entitlement + usage (one entry per LeaveType.code this
  // employee has taken or been granted a specific allowance for).
  leave_entitlements: [{
    code:            String,
    entitlement_days:{ type: Number, default: 0 },
    used_days:       { type: Number, default: 0 },
  }],
  // Personal
  photo:            String, // base64
  date_of_birth:    Date,
  gender:           { type: String, enum: ['male','female','other'] },
  nationality:      String,
  marital_status:   { type: String, enum: ['single','married','divorced','widowed'] },
  national_id:      String,
  address:          String,
  employment_type:  { type: String, enum: ['full_time','part_time','contract','intern'], default: 'full_time' },
  // Statutory (Ghana) — required for SSNIT & GRA PAYE filing
  ssnit_number:     String,
  tin:              String, // Tax Identification Number
  // Payment / bank details — how the employee is paid
  payment_method:   { type: String, enum: ['bank','momo','cash'], default: 'bank' },
  bank_name:        String,
  bank_account_name:String,
  bank_account_number: String,
  bank_branch:      String,
  momo_number:      String,
  // Emergency contact
  emergency_name:   String,
  emergency_phone:  String,
  emergency_relation: String,
  // Documents (base64)
  documents: [{
    name:      String,
    type:      String, // id_card, passport, certificate, contract, other
    file:      String, // base64
    mime_type: String,
    uploaded_at: { type: Date, default: Date.now },
  }],
}, { timestamps: true });
employeeSchema.index({ tenant_id: 1, employee_code: 1 }, { unique: true });

// EMPLOYEE LOAN / SALARY ADVANCE
const employeeLoanSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:   { type: Schema.Types.ObjectId, ref: 'Branch' },
  employee_id: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  type:        { type: String, enum: ['loan', 'advance'], default: 'loan' },
  reason:      String,
  principal:         { type: Number, required: true }, // original amount disbursed
  balance:           { type: Number, required: true }, // amount still owed
  monthly_deduction: { type: Number, required: true }, // installment taken from each pay run
  status:      { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active' },
  disbursed_date: { type: Date, default: Date.now },
  repayments: [{
    month:          Number,
    year:           Number,
    amount:         Number,
    payroll_run_id: { type: Schema.Types.ObjectId, ref: 'PayrollRun' },
    date:           { type: Date, default: Date.now },
  }],
  created_by:  { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
employeeLoanSchema.index({ tenant_id: 1, employee_id: 1, status: 1 });

// ATTENDANCE
const attendanceSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:   { type: Schema.Types.ObjectId, ref: 'Branch' },
  employee_id: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  date:        { type: Date, required: true },
  status:      { type: String, enum: ['present','absent','half_day','leave','holiday'], default: 'present' },
  clock_in:       Date,
  clock_out:      Date,
  hours_worked:   Number, // computed from clock_in/clock_out
  overtime_hours: Number, // hours_worked beyond the tenant's standard_hours_per_day
  notes:       String,
}, { timestamps: true });
attendanceSchema.index({ tenant_id: 1, employee_id: 1, date: 1 }, { unique: true });

// LEAVE TYPE — tenant-configurable leave categories with their own entitlement
const leaveTypeSchema = new Schema({
  tenant_id:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:          { type: String, required: true },
  code:          { type: String, required: true }, // slug, e.g. 'maternity'
  default_days:  { type: Number, default: 0 },      // standard entitlement per employee per year
  paid:          { type: Boolean, default: true },
  is_active:     { type: Boolean, default: true },
  created_by:    { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
leaveTypeSchema.index({ tenant_id: 1, code: 1 }, { unique: true });

// PUBLIC HOLIDAY — excluded from leave-day counts and attendance expectations
const publicHolidaySchema = new Schema({
  tenant_id:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:          { type: String, required: true },
  date:          { type: Date, required: true },
  is_recurring:  { type: Boolean, default: false }, // repeats on this month/day every year
  created_by:    { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
publicHolidaySchema.index({ tenant_id: 1, date: 1 });

// LEAVE REQUEST
const leaveRequestSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:   { type: Schema.Types.ObjectId, ref: 'Branch' },
  employee_id: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  leave_type:  { type: String, default: 'annual' },
  start_date:  { type: Date, required: true },
  end_date:    { type: Date, required: true },
  reason:      String,
  status:      { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  reviewed_by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// PERFORMANCE APPRAISAL — simple periodic rating + comments
// Fixed set of standard rating competencies — not tenant-configurable.
const APPRAISAL_CATEGORIES = [
  'Job Knowledge',
  'Quality of Work',
  'Productivity',
  'Communication',
  'Teamwork',
  'Initiative & Problem-Solving',
  'Punctuality & Attendance',
];

const appraisalCategoryRatingSchema = new Schema({
  category: { type: String, required: true, enum: APPRAISAL_CATEGORIES },
  rating:   { type: Number, required: true, min: 1, max: 5 },
}, { _id: false });

const appraisalSchema = new Schema({
  tenant_id:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:    { type: Schema.Types.ObjectId, ref: 'Branch' },
  employee_id:  { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  reviewer_id:  { type: Schema.Types.ObjectId, ref: 'User' },
  period_start: { type: Date, required: true },
  period_end:   { type: Date, required: true },
  category_ratings: {
    type: [appraisalCategoryRatingSchema],
    validate: {
      validator: (v) => v.length === APPRAISAL_CATEGORIES.length,
      message: `category_ratings must include a rating for every one of the ${APPRAISAL_CATEGORIES.length} standard categories.`,
    },
  },
  overall_rating: { type: Number, min: 1, max: 5 }, // computed average of category_ratings
  strengths:             String,
  areas_for_improvement: String,
  goals_next_period:     String,
  status:            { type: String, enum: ['draft','submitted','acknowledged'], default: 'draft' },
  employee_comments: String,
  submitted_at:      Date,
  acknowledged_at:   Date,
  created_by:   { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
appraisalSchema.index({ tenant_id: 1, employee_id: 1, createdAt: -1 });

// PAYROLL RUN
const payrollRunSchema = new Schema({
  tenant_id:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:    { type: Schema.Types.ObjectId, ref: 'Branch' },
  employee_id:  { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  month:        { type: Number, required: true },
  year:         { type: Number, required: true },
  gross_salary: { type: Number, required: true },
  allowances:   { type: Number, default: 0 },
  allowance_lines: [{ name: String, amount: Number }],
  deductions:   { type: Number, default: 0 },
  deduction_lines: [{ name: String, amount: Number, loan_id: { type: Schema.Types.ObjectId, ref: 'EmployeeLoan' } }],
  // Set only when this run covers a partial period (mid-month joiner/leaver).
  proration: {
    worked_days:       Number,
    total_days:        Number,
    full_gross_salary: Number, // the employee's normal (unprorated) monthly salary
  },
  paye:         { type: Number, default: 0 },
  ssnit_employee: { type: Number, default: 0 },
  ssnit_employer: { type: Number, default: 0 },
  net_salary:   { type: Number, required: true },
  status:       { type: String, enum: ['draft','submitted','approved','paid'], default: 'submitted' },
  approved_by:  { type: Schema.Types.ObjectId, ref: 'User' },
  batch_id:     { type: Schema.Types.ObjectId, ref: 'PayrollBatch' },
}, { timestamps: true });
payrollRunSchema.index({ tenant_id: 1, employee_id: 1, month: 1, year: 1 }, { unique: true });

// PAYROLL BATCH — one pay run for a period grouping all employees' payslips
const payrollBatchSchema = new Schema({
  tenant_id:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:    { type: Schema.Types.ObjectId, ref: 'Branch' },
  month:        { type: Number, required: true },
  year:         { type: Number, required: true },
  label:        String, // e.g. "January 2025"
  status:       { type: String, enum: ['draft','approved','paid'], default: 'draft' },
  employee_count:       { type: Number, default: 0 },
  total_gross:          { type: Number, default: 0 },
  total_allowances:     { type: Number, default: 0 },
  total_deductions:     { type: Number, default: 0 },
  total_paye:           { type: Number, default: 0 },
  total_ssnit_employee: { type: Number, default: 0 },
  total_ssnit_employer: { type: Number, default: 0 },
  total_net:            { type: Number, default: 0 },
  created_by:   { type: Schema.Types.ObjectId, ref: 'User' },
  approved_by:  { type: Schema.Types.ObjectId, ref: 'User' },
  approved_at:  Date,
  paid_at:      Date,
  journal_entry_id: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
}, { timestamps: true });
payrollBatchSchema.index({ tenant_id: 1, year: -1, month: -1 });

// CARD AUTHORIZATION
const cardAuthorizationSchema = new Schema({
  tenant_id:          { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  user_id:            { type: Schema.Types.ObjectId, ref: 'User', required: true },
  authorization_code: { type: String, required: true },
  card_type:          String,
  last4:              String,
  exp_month:          String,
  exp_year:           String,
  bank:               String,
  email:              String,
  is_active:          { type: Boolean, default: true },
}, { timestamps: true });

// BILLING TRANSACTION
const billingTransactionSchema = new Schema({
  tenant_id:         { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  plan:              { type: String, enum: ['starter','pro','enterprise','custom'], required: true },
  subscription_type: { type: String, enum: ['plan','custom'], default: 'plan' },
  modules:           { type: [String], default: [] },
  addons:            { type: [String], default: [] },
  amount:          { type: Number, required: true },
  currency:        { type: String, default: 'USD' },
  status:          { type: String, enum: ['pending','success','failed'], default: 'pending' },
  payment_ref:     String,
  payment_method:  String,
  duration_days:   { type: Number, default: 30 },
  expires_at:      Date,
  initiated_by:    { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
billingTransactionSchema.index({ tenant_id: 1, createdAt: -1 });

// PAYMENT LOG
const paymentLogSchema = new Schema({
  tenant_id:      { type: Schema.Types.ObjectId, ref: 'Tenant' },
  source:         { type: String, enum: ['storefront','pos','internal_order','purchase_order','payroll'], required: true },
  reference:      { type: String, required: true },
  amount:         { type: Number, required: true },
  currency:       { type: String, default: 'GHS' },
  method:         { type: String, enum: ['paystack','cash','mobile_money','bank_transfer','card','manual'], default: 'manual' },
  status:         { type: String, enum: ['success','failed','pending','refunded'], default: 'success' },
  payer_name:     String,
  payer_email:    String,
  description:    String,
  source_id:      { type: Schema.Types.ObjectId },  // order_id, po_id, payroll_id etc
  recorded_by:    { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
paymentLogSchema.index({ tenant_id: 1, createdAt: -1 });
paymentLogSchema.index({ reference: 1 });

// PLATFORM SETTINGS
const platformSettingsSchema = new Schema({
  // Subscription plans
  trial_days:   { type: Number, default: 14 },
  grace_days:   { type: Number, default: 7 },
  auto_renew_default: { type: Boolean, default: true },
  currency:     { type: String, default: 'GHS' },
  plans:        { type: Schema.Types.Mixed, default: {
    starter:    { price: 29,  max_branches: 1,   max_users: 5   },
    pro:        { price: 79,  max_branches: 5,   max_users: 20  },
    enterprise: { price: 199, max_branches: 999, max_users: 999 },
  }},
  // Platform identity
  platform_name:  { type: String, default: 'GEMS' },
  support_email:  { type: String, default: 'support@gthink.com' },
  platform_logo:  { type: String, default: '' },
  // Payment gateway
  paystack_public_key:  { type: String, default: '' },
  paystack_secret_key:  { type: String, default: '' },
  paystack_webhook_url: { type: String, default: '' },
  paystack_virtual_terminal_code: { type: String, default: '' },
  paystack_terminal_whatsapp:     { type: String, default: '' },
  // Alerts
  trial_warning_days:   { type: Number, default: 3 },
  expiry_alert_days:    { type: Number, default: 7 },
  // Audit & data retention
  audit_retention_days: { type: Number, default: 90 },
  // Marketplace: platform commission (%) deducted from the tenant payout
  // for orders placed via the cross-tenant marketplace directory.
  marketplace_commission_pct: { type: Number, default: 5 },
  // SMS resold to tenants in prepaid bundles. Price is what the tenant pays;
  // the platform's margin is that price less what the SMS gateway charges.
  sms_bundles: { type: Schema.Types.Mixed, default: [
    { label: 'Starter',  credits: 100,  price: 15 },
    { label: 'Business', credits: 500,  price: 65 },
    { label: 'Bulk',     credits: 2000, price: 230 },
  ]},
  sms_sender_id: { type: String, default: 'GEMS' },
  // mNotify account the platform buys SMS through and resells from. Treated as
  // a secret: masked on read, only overwritten when a real value is sent.
  mnotify_api_key: { type: String, default: '' },
  // Feature flags per plan
  feature_flags: { type: Schema.Types.Mixed, default: {
    starter:    { pos: true, crm: false, accounting: false, hr: false, procurement: false, reports: false, storefront: true, projects: false },
    pro:        { pos: true, crm: true,  accounting: true,  hr: true,  procurement: true,  reports: true,  storefront: true, projects: true },
    enterprise: { pos: true, crm: true,  accounting: true,  hr: true,  procurement: true,  reports: true,  storefront: true, projects: true },
  }},
}, { timestamps: true });

// CUSTOM ROLE
const roleSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:        { type: String, required: true },
  permissions: { type: [String], default: [] },
  is_active:   { type: Boolean, default: true },
}, { timestamps: true });
roleSchema.index({ tenant_id: 1, name: 1 }, { unique: true });

// AUDIT LOG
const auditLogSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant' },
  branch_id:   { type: Schema.Types.ObjectId, ref: 'Branch' },
  user_id:     { type: Schema.Types.ObjectId, ref: 'User' },
  user_name:   String,
  user_email:  String,
  user_role:   String,
  action:      { type: String, required: true }, // e.g. LOGIN, CREATE_ORDER, UPDATE_PRODUCT
  module:      { type: String, required: true }, // e.g. auth, orders, inventory
  description: { type: String, required: true }, // human readable
  metadata:    { type: Schema.Types.Mixed },      // extra data e.g. { order_number, total }
  ip:          String,
  user_agent:  String,                            // raw browser/device user-agent
  device:      String,                            // parsed label e.g. "Chrome on Windows · Desktop"
  status:      { type: String, enum: ['success','failed'], default: 'success' },
}, { timestamps: true });
auditLogSchema.index({ tenant_id: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

// STORAGE LOCATION (shelf / zone / bin / warehouse area)
const storageLocationSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:   { type: Schema.Types.ObjectId, ref: 'Branch' },
  name:        { type: String, required: true },
  code:        { type: String },
  type:        { type: String, enum: ['warehouse','zone','shelf','bin','room','other'], default: 'shelf' },
  description: String,
  is_active:   { type: Boolean, default: true },
}, { timestamps: true });
storageLocationSchema.index({ tenant_id: 1, code: 1 }, { unique: true, sparse: true });

// ASSET CATEGORY
const assetCategorySchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:        { type: String, required: true },
  description: String,
}, { timestamps: true });
assetCategorySchema.index({ tenant_id: 1, name: 1 }, { unique: true });

// ASSET
const assetSchema = new Schema({
  tenant_id:       { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:       { type: Schema.Types.ObjectId, ref: 'Branch' },
  asset_code:      { type: String, required: true },
  name:            { type: String, required: true },
  category_id:     { type: Schema.Types.ObjectId, ref: 'AssetCategory' },
  description:     String,
  purchase_date:   Date,
  purchase_value:  { type: Number, default: 0 },
  current_value:   { type: Number, default: 0 },
  condition:       { type: String, enum: ['excellent','good','fair','poor','disposed'], default: 'good' },
  status:          { type: String, enum: ['active','under_repair','disposed','lost'], default: 'active' },
  assigned_to:     { type: Schema.Types.ObjectId, ref: 'Employee' },
  location_id:     { type: Schema.Types.ObjectId, ref: 'StorageLocation' },
  serial_number:   String,
  warranty_expiry: Date,
  notes:           String,
  images:          [String],
  created_by:      { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
assetSchema.index({ tenant_id: 1, asset_code: 1 }, { unique: true });

// ASSET LOG (maintenance / repair / transfer history)
const assetLogSchema = new Schema({
  tenant_id:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  asset_id:      { type: Schema.Types.ObjectId, ref: 'Asset', required: true },
  type:          { type: String, enum: ['maintenance','repair','transfer','condition_change','disposal','note'], required: true },
  notes:         { type: String, required: true },
  cost:          { type: Number, default: 0 },
  from_location: { type: Schema.Types.ObjectId, ref: 'StorageLocation' },
  to_location:   { type: Schema.Types.ObjectId, ref: 'StorageLocation' },
  from_employee: { type: Schema.Types.ObjectId, ref: 'Employee' },
  to_employee:   { type: Schema.Types.ObjectId, ref: 'Employee' },
  created_by:    { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
assetLogSchema.index({ tenant_id: 1, asset_id: 1, createdAt: -1 });

// CHAT CONVERSATION
const chatConversationSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  opened_by:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  subject:     { type: String, default: 'Support Request' },
  status:      { type: String, enum: ['open','resolved'], default: 'open' },
  last_message_at: { type: Date, default: Date.now },
  unread_admin: { type: Number, default: 0 }, // unread count for platform admin
  unread_tenant:{ type: Number, default: 0 }, // unread count for tenant user
}, { timestamps: true });

// CHAT MESSAGE
const chatMessageSchema = new Schema({
  conversation_id: { type: Schema.Types.ObjectId, ref: 'ChatConversation', required: true },
  tenant_id:       { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  sender_id:       { type: Schema.Types.ObjectId, ref: 'User', required: true },
  sender_role:     { type: String, enum: ['tenant','admin'], required: true },
  message:         { type: String, required: true },
  read:            { type: Boolean, default: false },
}, { timestamps: true });
chatMessageSchema.index({ conversation_id: 1, createdAt: 1 });
const cartItemSchema = new Schema({
  product_id:          { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  product_name:        String,
  price:               Number,
  quantity:            { type: Number, required: true, min: 1 },
  images:              [String],
  category_name:       String,
  stock_qty:           Number,
  low_stock_threshold: Number,
  sku:                 String,
  branch_id:           { type: Schema.Types.ObjectId, ref: 'Branch' },
  branch_name:         String,
  branch_slug:         String,
  item_type:           { type: String, enum: ['product', 'service', 'bundle'], default: 'product' },
  unit_type:           String,
  duration:            Number,
});

const cartSchema = new Schema({
  tenant_id:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:  { type: Schema.Types.ObjectId, ref: 'Branch' },
  cart_id:    { type: String, required: true, unique: true },
  items:      [cartItemSchema],
  expires_at: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

// TAX RATE
const taxRateSchema = new Schema({
  tenant_id:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:       { type: String, required: true },
  rate:       { type: Number, required: true },
  applies_to: { type: String, enum: ['sales','purchases','both'], default: 'both' },
  is_active:  { type: Boolean, default: true },
}, { timestamps: true });

// INVOICE
const invoicePaymentSchema = new Schema({
  date:      { type: Date, default: Date.now },
  amount:    { type: Number, required: true },
  method:    { type: String, enum: ['cash','card','mobile_money','bank_transfer','paystack','manual'], default: 'cash' },
  reference: String,
  note:      String,
});

const invoiceLineSchema = new Schema({
  description: { type: String, required: true },
  quantity:    { type: Number, required: true, default: 1 },
  unit_price:  { type: Number, required: true },
  tax_rate:    { type: Number, default: 0 },   // % e.g. 15
  total:       { type: Number, required: true },
});

const invoiceSchema = new Schema({
  tenant_id:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:      { type: Schema.Types.ObjectId, ref: 'Branch' },
  invoice_number: { type: String, required: true },
  customer_id:    { type: Schema.Types.ObjectId, ref: 'Customer' },
  customer_name:  { type: String, required: true },
  customer_email: String,
  issue_date:     { type: Date, default: Date.now },
  due_date:       { type: Date, required: true },
  lines:          [invoiceLineSchema],
  subtotal:       { type: Number, default: 0 },
  tax_amount:     { type: Number, default: 0 },
  total:          { type: Number, default: 0 },
  amount_paid:    { type: Number, default: 0 },
  amount_due:     { type: Number, default: 0 },
  payments:       [invoicePaymentSchema],
  status:         { type: String, enum: ['draft','sent','partially_paid','paid','overdue','void'], default: 'draft' },
  notes:          String,
  order_id:       { type: Schema.Types.ObjectId, ref: 'Order' },
  project_id:     { type: Schema.Types.ObjectId, ref: 'Project' },
  // Progress billing. Construction valuations are cumulative — the gross value
  // of work certified in this application, before the client's retention is
  // withheld. `total` is what is actually due, i.e. work_value less retention.
  work_value:       { type: Number, default: 0 },
  retention_amount: { type: Number, default: 0 },
  // An invoice that bills back retention held on earlier applications, rather
  // than certifying new work. Carries no work_value of its own.
  is_retention_release: { type: Boolean, default: false },
  journal_entry_id: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  created_by:     { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
invoiceSchema.index({ tenant_id: 1, invoice_number: 1 }, { unique: true });

// CREDIT NOTE
const creditNoteSchema = new Schema({
  tenant_id:         { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:         { type: Schema.Types.ObjectId, ref: 'Branch' },
  credit_note_number:{ type: String, required: true },
  invoice_id:        { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
  customer_id:       { type: Schema.Types.ObjectId, ref: 'Customer' },
  customer_name:     { type: String, required: true },
  amount:            { type: Number, required: true },
  reason:            { type: String, required: true },
  status:            { type: String, enum: ['draft','applied','void'], default: 'draft' },
  created_by:        { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
creditNoteSchema.index({ tenant_id: 1, credit_note_number: 1 }, { unique: true });

// ACCOUNTING PERIOD
const accountingPeriodSchema = new Schema({
  tenant_id:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:       { type: String, required: true },       // e.g. 'January 2025', 'FY 2025'
  type:       { type: String, enum: ['month','year'], default: 'month' },
  start_date: { type: Date, required: true },
  end_date:   { type: Date, required: true },
  status:     { type: String, enum: ['open','closed'], default: 'open' },
  closed_by:  { type: Schema.Types.ObjectId, ref: 'User' },
  closed_at:  Date,
}, { timestamps: true });
accountingPeriodSchema.index({ tenant_id: 1, start_date: 1 }, { unique: true });

const vendorBillLineSchema = new Schema({
  description: String,
  quantity:    { type: Number, default: 1 },
  unit_price:  { type: Number, default: 0 },
  tax_rate:    { type: Number, default: 0 },
  total:       { type: Number, default: 0 },
}, { _id: false });

const vendorBillPaymentSchema = new Schema({
  amount:    { type: Number, required: true },
  method:    { type: String, default: 'bank_transfer' },
  reference: String,
  note:      String,
  date:      { type: Date, default: Date.now },
}, { _id: true });

const vendorBillSchema = new Schema({
  tenant_id:        { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:        { type: Schema.Types.ObjectId, ref: 'Branch' },
  bill_number:      { type: String, required: true },
  vendor_name:      { type: String, required: true },
  supplier_id:      { type: Schema.Types.ObjectId, ref: 'Supplier' },
  issue_date:       { type: Date, default: Date.now },
  due_date:         { type: Date, required: true },
  lines:            [vendorBillLineSchema],
  subtotal:         { type: Number, default: 0 },
  tax_amount:       { type: Number, default: 0 },
  total:            { type: Number, default: 0 },
  amount_paid:      { type: Number, default: 0 },
  amount_due:       { type: Number, default: 0 },
  expense_account_id: { type: Schema.Types.ObjectId, ref: 'Account' },
  journal_entry_id: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
  payments:         [vendorBillPaymentSchema],
  status:           { type: String, enum: ['draft','posted','partially_paid','paid','void'], default: 'draft' },
  notes:            String,
  created_by:       { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
vendorBillSchema.index({ tenant_id: 1, bill_number: 1 }, { unique: true });

const bankReconLineSchema = new Schema({
  line_id:       String,
  date:          String,
  description:   String,
  amount:        Number,
  matched_gl_id: String,
  matched:       { type: Boolean, default: false },
}, { _id: true });

const bankReconGlLineSchema = new Schema({
  gl_line_id:           String,
  entry_id:             String,
  date:                 String,
  reference:            String,
  description:          String,
  source:               String,
  amount:               Number,
  matched:              { type: Boolean, default: false },
  matched_bank_line_id: String,
}, { _id: true });

const bankReconMatchedPairSchema = new Schema({
  bank_line_id:     String,
  gl_line_id:       String,
  bank_date:        String,
  bank_description: String,
  bank_amount:      Number,
  gl_date:          String,
  gl_reference:     String,
  gl_description:   String,
  gl_amount:        Number,
  match_score:      Number,
}, { _id: false });

const bankReconciliationSchema = new Schema({
  tenant_id:         { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  account_id:        { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  statement_date:    { type: Date, required: true },
  period_from:       Date,
  period_to:         Date,
  opening_balance:   { type: Number, default: null },
  closing_balance:   { type: Number, default: null },
  bank_total:        { type: Number, default: null },
  gl_period_total:   { type: Number, default: null },
  bank_line_count:   { type: Number, default: null },
  gl_line_count:     { type: Number, default: null },
  matched_count:     { type: Number, default: null },
  match_rate:        { type: Number, default: null },
  period_difference: { type: Number, default: null },
  bank_lines:        [bankReconLineSchema],
  gl_lines:          [bankReconGlLineSchema],
  matched_pairs:     [bankReconMatchedPairSchema],
  status:            { type: String, enum: ['draft','completed'], default: 'draft' },
  completed_by:      { type: Schema.Types.ObjectId, ref: 'User' },
  completed_at:      Date,
  notes:             String,
}, { timestamps: true });

// BUDGET
const budgetSchema = new Schema({
  tenant_id:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  category:   { type: String, required: true },
  period:     { type: String, required: true }, // e.g. '2024-01', '2024' for annual
  period_type:{ type: String, enum: ['monthly','annual'], default: 'monthly' },
  amount:     { type: Number, required: true },
}, { timestamps: true });
budgetSchema.index({ tenant_id: 1, category: 1, period: 1 }, { unique: true });

// POS SHIFT
const posShiftSchema = new Schema({
  tenant_id:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:      { type: Schema.Types.ObjectId, ref: 'Branch' },
  shift_number:   { type: String, required: true },
  cashier_name:   String,
  opened_by:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
  closed_by:      { type: Schema.Types.ObjectId, ref: 'User' },
  status:         { type: String, enum: ['open', 'closed'], default: 'open' },
  opened_at:      { type: Date, default: Date.now },
  closed_at:      Date,
  opening_float:  { type: Number, default: 0 },
  expected_cash:  { type: Number, default: 0 },
  actual_cash:    { type: Number, default: 0 },
  cash_variance:  { type: Number, default: 0 },
  sales_count:    { type: Number, default: 0 },
  sales_total:    { type: Number, default: 0 },
  refunds_total:  { type: Number, default: 0 },
  card_total:     { type: Number, default: 0 },
  momo_total:     { type: Number, default: 0 },
  notes:          String,
}, { timestamps: true });
posShiftSchema.index({ tenant_id: 1, opened_by: 1, status: 1 });

// POS CUSTOMER DISPLAY (one active session per branch)
const posCustomerDisplaySchema = new Schema({
  tenant_id:          { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:          { type: Schema.Types.ObjectId, ref: 'Branch' },
  branch_key:         { type: String, required: true, default: 'default' },
  order_id:           { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  order_number:       String,
  customer_name:      String,
  amount:             Number,
  authorization_url:  String,
  reference:          String,
  payment_method:     String,
  published_by:       { type: Schema.Types.ObjectId, ref: 'User' },
  published_at:       Date,
  expires_at:         Date,
  status:             { type: String, enum: ['active', 'cleared', 'expired'], default: 'active' },
  paid_flash: {
    order_id:       { type: Schema.Types.ObjectId, ref: 'Order' },
    order_number:   String,
    customer_name:  String,
    amount:         Number,
    at:             Date,
  },
}, { timestamps: true });
posCustomerDisplaySchema.index({ tenant_id: 1, branch_key: 1 }, { unique: true });

// STOREFRONT CUSTOMER
const storeCustomerSchema = new Schema({
  tenant_id:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:          { type: String, required: true },
  email:         { type: String, required: true, lowercase: true, trim: true },
  password_hash: { type: String, default: '' },
  phone:         String,
  google_id:     { type: String, sparse: true },
  avatar:        String,
  auth_provider: { type: String, enum: ['local', 'google'], default: 'local' },
}, { timestamps: true });
storeCustomerSchema.index({ tenant_id: 1, email: 1 }, { unique: true });

// SMS PURCHASE — a tenant buying a prepaid credit bundle from the platform.
const smsPurchaseSchema = new Schema({
  tenant_id:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  credits:        { type: Number, required: true },
  amount:         { type: Number, required: true },
  currency:       { type: String, default: 'GHS' },
  bundle_label:   String,
  status:         { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  reference:      { type: String, required: true },
  payment_ref:    String,
  payment_method: String,
  initiated_by:   { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
smsPurchaseSchema.index({ tenant_id: 1, createdAt: -1 });
smsPurchaseSchema.index({ reference: 1 }, { unique: true });

// SMS TEMPLATE — a tenant's override of a built-in message.
//
// Only customised templates are stored; anything absent falls back to the
// built-in default in smsService, so new templates ship without a migration.
const smsTemplateSchema = new Schema({
  tenant_id:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  key:        { type: String, required: true },
  body:       { type: String, required: true },
  enabled:    { type: Boolean, default: true },
  updated_by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
smsTemplateSchema.index({ tenant_id: 1, key: 1 }, { unique: true });

// SMS MESSAGE — one row per send attempt, including blocked ones, so a tenant
// can see what went out and what didn't and why.
const smsMessageSchema = new Schema({
  tenant_id:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  to:            { type: String, required: true },
  body:          { type: String, required: true },
  template_key:  String,
  segments:      { type: Number, default: 1 },
  credits_used:  { type: Number, default: 0 },
  status:        { type: String, enum: ['sent', 'failed', 'insufficient_credits', 'disabled'], required: true },
  error:         String,
  provider:      String,
  provider_ref:  String,
  source:        String,                                       // e.g. 'order_confirmed', 'campaign'
  sent_by:       { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
smsMessageSchema.index({ tenant_id: 1, createdAt: -1 });

// ── PROJECTS ──────────────────────────────────────────────────────────────
//
// Contract work tracked from award to completion. Three numbers have to stay
// honest: how much work is actually done, what it has cost, and what is owed
// under the contract. Progress is therefore derived from weighted milestones
// rather than typed in, and cost is captured by tagging records that already
// exist (expenses, purchase orders) instead of a parallel ledger that drifts
// out of step with accounting.

const projectCostLineSchema = new Schema({
  // Free-form so the same module suits site work (materials, plant,
  // subcontractors) and professional services (labour, licences, travel).
  category:  { type: String, required: true },
  budget:    { type: Number, default: 0 },
  notes:     String,
}, { _id: true });

const projectSchema = new Schema({
  tenant_id:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:      { type: Schema.Types.ObjectId, ref: 'Branch' },
  code:           { type: String, required: true },
  name:           { type: String, required: true },
  description:    String,
  // The client who awarded the contract.
  customer_id:    { type: Schema.Types.ObjectId, ref: 'Customer' },
  customer_name:  String,
  // Original contract sum. Approved variations are held separately so the
  // agreed figure and what changed since stay distinguishable.
  contract_value: { type: Number, default: 0 },
  currency:       { type: String, default: 'GHS' },
  budget_lines:   { type: [projectCostLineSchema], default: [] },
  // Percentage the client withholds until completion — standard on
  // construction contracts, zero for most service work.
  retention_pct:  { type: Number, default: 0 },
  // How long the client takes to pay a certified application. The single
  // biggest driver of a contractor's cash position — work certified in March
  // on 60-day terms is May's money, and the wages in between still fall due.
  payment_terms_days: { type: Number, default: 30 },
  // Gap between completion and retention being released. Typically the
  // defects liability period, six or twelve months on most contracts.
  defects_liability_days: { type: Number, default: 0 },
  // Used to turn hours lost on site into days of extension claimed.
  working_hours_per_day: { type: Number, default: 8 },
  // Texting a client who never asked to be texted is a good way to lose one,
  // and every message spends the tenant's credits — so this stays off until
  // somebody turns it on for this particular job.
  client_sms_enabled: { type: Boolean, default: false },
  // Who to text. Falls back to the client record's number; set here when the
  // day-to-day contact on site isn't whoever the account was opened with.
  client_phone:       { type: String, default: '' },
  start_date:     Date,
  planned_end_date: Date,
  actual_end_date:  Date,
  status:         { type: String, enum: ['draft', 'active', 'on_hold', 'completed', 'cancelled'], default: 'draft' },
  manager_id:     { type: Schema.Types.ObjectId, ref: 'Employee' },
  team:           [{ type: Schema.Types.ObjectId, ref: 'Employee' }],
  site_address:   String,
  // Cached from the milestone weights so lists don't have to aggregate.
  // projectService.recalculate is the only thing that writes it.
  progress_pct:   { type: Number, default: 0 },
  created_by:     { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
projectSchema.index({ tenant_id: 1, branch_id: 1, status: 1 });
projectSchema.index({ tenant_id: 1, code: 1 }, { unique: true });

// A stage of work. Weight is its share of the whole job, so overall progress
// is the weighted average rather than a figure somebody felt like typing.
const projectMilestoneSchema = new Schema({
  tenant_id:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  project_id:    { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  name:          { type: String, required: true },
  description:   String,
  weight:        { type: Number, default: 1, min: 0 },
  sequence:      { type: Number, default: 0 },
  planned_start: Date,
  planned_end:   Date,
  actual_start:  Date,
  actual_end:    Date,
  status:        { type: String, enum: ['not_started', 'in_progress', 'completed', 'blocked'], default: 'not_started' },
  // Set directly when a milestone has no tasks; otherwise rolled up from them.
  progress_pct:  { type: Number, default: 0, min: 0, max: 100 },
  // What may be invoiced when this stage is certified complete.
  billable_amount: { type: Number, default: 0 },
  // Set once the stage has been billed, so it can't be certified twice.
  billed_invoice_id: { type: Schema.Types.ObjectId, ref: 'Invoice' },
}, { timestamps: true });
projectMilestoneSchema.index({ tenant_id: 1, project_id: 1, sequence: 1 });

const projectTaskSchema = new Schema({
  tenant_id:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  project_id:   { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  milestone_id: { type: Schema.Types.ObjectId, ref: 'ProjectMilestone' },
  name:         { type: String, required: true },
  description:  String,
  weight:       { type: Number, default: 1, min: 0 },
  assignee_id:  { type: Schema.Types.ObjectId, ref: 'Employee' },
  due_date:     Date,
  completed_at: Date,
  status:       { type: String, enum: ['todo', 'in_progress', 'done', 'blocked'], default: 'todo' },
  created_by:   { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
projectTaskSchema.index({ tenant_id: 1, project_id: 1, milestone_id: 1 });

// A change to the agreed scope. Without these the contract value is fiction
// within a month, and every budget comparison built on it is wrong.
const projectVariationSchema = new Schema({
  tenant_id:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  project_id:   { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  reference:    { type: String, required: true },
  description:  { type: String, required: true },
  // Signed: a negative amount is an omission from the contract.
  amount:       { type: Number, required: true },
  status:       { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  raised_on:    { type: Date, default: Date.now },
  decided_on:   Date,
  decided_by:   { type: Schema.Types.ObjectId, ref: 'User' },
  created_by:   { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
projectVariationSchema.index({ tenant_id: 1, project_id: 1, status: 1 });

// Labour against a project. Attendance records when someone clocked in, not
// what they worked on, so time has to be booked separately to be costed.
const projectTimeLogSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  project_id:  { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  task_id:     { type: Schema.Types.ObjectId, ref: 'ProjectTask' },
  employee_id: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  work_date:   { type: Date, required: true },
  hours:       { type: Number, required: true, min: 0 },
  // Snapshot, so historic cost doesn't move when a rate is revised. Where the
  // day carried overtime this is the blended rate for that day, not the base.
  hourly_rate: { type: Number, default: 0 },
  cost:        { type: Number, default: 0 },
  // 'attendance' — split out of a day the person was recorded as present, and
  //                so replaceable as a block when that day is re-allocated.
  // 'manual'     — booked directly against a project by someone who knew what
  //                was worked on, and never overwritten by an allocation.
  source:        { type: String, enum: ['manual', 'attendance'], default: 'manual' },
  attendance_id: { type: Schema.Types.ObjectId, ref: 'Attendance' },
  notes:       String,
  created_by:  { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
projectTimeLogSchema.index({ tenant_id: 1, project_id: 1, work_date: -1 });
// Reading a person's day back across every project they touched — the query
// behind both the allocation board and the guard against booking more hours
// than were actually worked.
projectTimeLogSchema.index({ tenant_id: 1, employee_id: 1, work_date: 1 });

// A day on site. Beyond being a record of what happened, this is the evidence
// base for an extension-of-time claim — which is why weather and delays are
// captured as structured fields with hours lost, rather than buried in prose.
// A claim argued from "it rained a lot in March" goes nowhere; one argued from
// dated entries with hours attributed to a cause is answerable.
const projectDelaySchema = new Schema({
  cause:       { type: String, enum: ['weather', 'materials', 'labour', 'plant', 'client_instruction', 'access', 'other'], required: true },
  hours_lost:  { type: Number, default: 0, min: 0 },
  description: String,
}, { _id: true });

const projectDiarySchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  project_id:  { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  entry_date:  { type: Date, required: true },
  weather:     { type: String, enum: ['fine', 'overcast', 'light_rain', 'heavy_rain', 'storm'], default: 'fine' },
  temperature: Number,
  // False when the site could not be worked at all — the strongest single
  // signal when totalling lost time.
  worked:      { type: Boolean, default: true },
  labour_count: { type: Number, default: 0 },
  labour_notes: String,
  plant_notes:  String,
  work_done:    String,
  materials_received: String,
  delays:       { type: [projectDelaySchema], default: [] },
  visitors:     String,
  instructions: String,
  recorded_by:  { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
// One entry per site per day — a second entry for the same date would double
// count lost hours in any claim built from these.
projectDiarySchema.index({ tenant_id: 1, project_id: 1, entry_date: -1 }, { unique: true });

// Drawings, contracts, permits, certificates and site photographs.
const projectDocumentSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  project_id:  { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  name:        { type: String, required: true },
  category:    { type: String, enum: ['contract', 'drawing', 'permit', 'certificate', 'photo', 'correspondence', 'other'], default: 'other' },
  url:         { type: String, required: true },
  public_id:   String,
  mime_type:   String,
  size:        Number,
  notes:       String,
  // Site photographs belong to the day they were taken.
  diary_id:    { type: Schema.Types.ObjectId, ref: 'ProjectDiary' },
  uploaded_by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
projectDocumentSchema.index({ tenant_id: 1, project_id: 1, category: 1 });

// A frozen copy of the programme as it stood when it was agreed.
//
// Dates on the live milestones get edited as a job moves — that is what they
// are for. The cost of editing them in place is that the original commitment
// disappears, and "we are three weeks behind the award programme" becomes
// unanswerable. Freezing a copy is what makes slip measurable at all, and it
// is also the only thing that turns progress into a schedule metric: without a
// baseline there is no planned-to-date figure to compare actual progress with.
const projectBaselineMilestoneSchema = new Schema({
  milestone_id:    { type: Schema.Types.ObjectId, ref: 'ProjectMilestone' },
  name:            String,
  weight:          { type: Number, default: 1 },
  planned_start:   Date,
  planned_end:     Date,
  billable_amount: { type: Number, default: 0 },
}, { _id: false });

const projectBaselineSchema = new Schema({
  tenant_id:  { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  project_id: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  // Rises with each re-baseline. Superseded versions are kept rather than
  // overwritten — a programme revised three times is itself the evidence, and
  // an extension of time is argued from the version it was granted against.
  version:    { type: Number, required: true },
  name:       { type: String, required: true },
  reason:     String,
  start_date:       Date,
  planned_end_date: Date,
  // The contract sum at the moment of freezing, so planned value is measured
  // against what was agreed then rather than what it has since become.
  contract_value:   { type: Number, default: 0 },
  milestones: { type: [projectBaselineMilestoneSchema], default: [] },
  is_current: { type: Boolean, default: true },
  set_by:     { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
projectBaselineSchema.index({ tenant_id: 1, project_id: 1, version: -1 });
// Exactly one live baseline per project — two would make every variance figure
// depend on which one happened to be read.
projectBaselineSchema.index(
  { tenant_id: 1, project_id: 1, is_current: 1 },
  { unique: true, partialFilterExpression: { is_current: true } },
);

// A claim for more time.
//
// Running late is not by itself a claim. What matters is whether the delay was
// the contractor's own risk or the client's: rain and a late client
// instruction both stop work, but only one of them earns an extension, and
// only some of those also earn the cost of standing around. The diary already
// records lost hours against a cause, which is the hard part — this is the
// claim built from them, and the decision made on it.
//
// The snapshot matters as much as the claim. Diary entries can be edited after
// the fact, so what was argued has to be frozen at submission or the record of
// the claim quietly drifts away from the claim that was actually made.
const projectEotCauseSchema = new Schema({
  cause:           String,
  hours_lost:      { type: Number, default: 0 },
  days_equivalent: { type: Number, default: 0 },
  // 'time_and_cost' — client's risk, earns an extension and prolongation cost
  // 'time_only'     — neutral event, earns an extension but no money
  // 'no_entitlement'— contractor's own risk
  // 'unclassified'  — needs a human to decide which of the above it is
  entitlement:     String,
}, { _id: false });

const projectEotClaimSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  project_id:  { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  reference:   { type: String, required: true },
  title:       { type: String, required: true },
  description: String,
  // The window of the diary the claim is argued from.
  period_from: { type: Date, required: true },
  period_to:   { type: Date, required: true },

  // Frozen at submission, from the diary as it read that day.
  causes:            { type: [projectEotCauseSchema], default: [] },
  hours_lost_total:  { type: Number, default: 0 },
  claimable_hours:   { type: Number, default: 0 },
  working_hours_per_day: { type: Number, default: 8 },
  // The diary entries relied on. Cited entries are what stops two claims
  // being argued from the same lost afternoon.
  diary_entry_ids:   [{ type: Schema.Types.ObjectId, ref: 'ProjectDiary' }],
  document_ids:      [{ type: Schema.Types.ObjectId, ref: 'ProjectDocument' }],

  days_claimed: { type: Number, required: true, min: 0 },
  // Prolongation cost, claimable only where the delay was the client's risk.
  cost_claimed: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['draft', 'submitted', 'granted', 'partially_granted', 'rejected', 'withdrawn'],
    default: 'draft',
  },
  submitted_on:   Date,
  decided_on:     Date,
  decided_by:     { type: Schema.Types.ObjectId, ref: 'User' },
  days_granted:   { type: Number, default: 0 },
  cost_granted:   { type: Number, default: 0 },
  decision_notes: String,

  // What the completion date was before this claim moved it, so a decision can
  // be undone without guessing.
  previous_end_date: Date,
  new_end_date:      Date,
  // The programme the claim was assessed against, and the one cut afterwards.
  baseline_id:    { type: Schema.Types.ObjectId, ref: 'ProjectBaseline' },
  rebaselined_to: { type: Schema.Types.ObjectId, ref: 'ProjectBaseline' },

  created_by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
projectEotClaimSchema.index({ tenant_id: 1, project_id: 1, createdAt: -1 });
projectEotClaimSchema.index({ tenant_id: 1, project_id: 1, reference: 1 }, { unique: true });

// PAYOUT METHOD
const payoutMethodSchema = new Schema({
  tenant_id:        { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  // null = organisation-wide, usable by every branch. Set = belongs to that
  // branch only (used when payout_settings.per_branch_methods is on).
  branch_id:        { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
  type:             { type: String, enum: ['mobile_money', 'bank'], required: true },
  label:            { type: String, required: true },          // e.g. "MTN MoMo - 024..."
  recipient_code:   { type: String, required: true },          // Paystack transfer recipient code
  account_number:   { type: String, required: true },
  account_name:     { type: String, required: true },
  bank_code:        { type: String, required: true },          // network code for momo, bank code for bank
  currency:         { type: String, default: 'GHS' },
  is_default:       { type: Boolean, default: false },
  is_active:        { type: Boolean, default: true },
}, { timestamps: true });
payoutMethodSchema.index({ tenant_id: 1, branch_id: 1 });

// PAYOUT — a withdrawal of collected takings to a payout method.
//
// Every transfer out of the Paystack balance, whether requested by a user or
// fired automatically on fulfillment, gets a row here. Withdrawable balance is
// derived as (paid Paystack takings) − (payouts not in a failed state), so the
// ledger stays correct no matter which path moved the money.
const payoutSchema = new Schema({
  tenant_id:        { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:        { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
  amount:           { type: Number, required: true },
  currency:         { type: String, default: 'GHS' },
  status:           { type: String, enum: ['pending', 'processing', 'paid', 'failed', 'reversed'], default: 'pending' },
  trigger:          { type: String, enum: ['manual', 'auto'], default: 'manual' },
  // Snapshot of the destination at the time of transfer, so history stays
  // readable even if the payout method is later edited or removed.
  payout_method_id: { type: Schema.Types.ObjectId, ref: 'PayoutMethod' },
  method_label:     String,
  recipient_code:   String,
  reference:        { type: String, required: true },          // our own reference
  transfer_code:    String,                                    // Paystack transfer code
  failure_reason:   String,
  requested_by:     { type: Schema.Types.ObjectId, ref: 'User' },
  completed_at:     Date,
  // True only while a *requested* payout is still in flight. Backs the unique
  // index below, which is what actually stops a scope having two withdrawals
  // running at once — a read-then-write check cannot, since two concurrent
  // requests can both read "none in flight". Automatic per-order payouts are
  // left unflagged: they are driven by orders rather than by a person, and
  // must not serialise behind one another.
  is_open:          { type: Boolean },
}, { timestamps: true });
payoutSchema.index({ tenant_id: 1, branch_id: 1, status: 1 });
payoutSchema.index({ reference: 1 }, { unique: true });
payoutSchema.index({ transfer_code: 1 });
payoutSchema.index(
  { tenant_id: 1, branch_id: 1 },
  { unique: true, partialFilterExpression: { is_open: true } },
);

// COUPON
const couponSchema = new Schema({
  tenant_id:         { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  code:              { type: String, required: true, uppercase: true, trim: true },
  discount_type:     { type: String, enum: ['percent', 'fixed'], default: 'percent' },
  discount_value:    { type: Number, required: true },
  min_order_amount:  { type: Number, default: 0 },
  max_uses:          { type: Number, default: 0 },
  used_count:        { type: Number, default: 0 },
  expires_at:        Date,
  is_active:         { type: Boolean, default: true },
}, { timestamps: true });
couponSchema.index({ tenant_id: 1, code: 1 }, { unique: true });

const promotionSchema = new Schema({
  tenant_id:      { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:           { type: String, required: true, trim: true },
  discount_type:  { type: String, enum: ['percent', 'fixed'], default: 'percent' },
  discount_value: { type: Number, required: true },
  applies_to:     { type: String, enum: ['all', 'category', 'products'], default: 'all' },
  category_ids:   [{ type: Schema.Types.ObjectId, ref: 'Category' }],
  product_ids:    [{ type: Schema.Types.ObjectId, ref: 'Product' }],
  starts_at:      { type: Date, default: Date.now },
  ends_at:        Date,
  is_active:      { type: Boolean, default: true },
}, { timestamps: true });
promotionSchema.index({ tenant_id: 1, is_active: 1 });

// toJSON aliases for all schemas
const allSchemas = [
  tenantSchema, branchSchema, userSchema, categorySchema, productSchema,
  stockMovementSchema, customerSchema, leadSchema, contactHistorySchema,
  orderSchema, supplierSchema, purchaseOrderSchema, accountSchema,
  journalEntrySchema, expenseSchema, departmentSchema, employeeSchema,
  attendanceSchema, leaveRequestSchema, appraisalSchema, payrollRunSchema, payrollBatchSchema, employeeLoanSchema,
  leaveTypeSchema, publicHolidaySchema, taxRateSchema,
  cartSchema, auditLogSchema, paymentLogSchema, budgetSchema,
  invoiceSchema, creditNoteSchema, accountingPeriodSchema, vendorBillSchema, bankReconciliationSchema,
  chatConversationSchema, chatMessageSchema, roleSchema,
  storageLocationSchema, assetCategorySchema, assetSchema, assetLogSchema,
  posShiftSchema, posCustomerDisplaySchema, storeCustomerSchema, couponSchema, promotionSchema,
  payoutMethodSchema, payoutSchema,
  smsPurchaseSchema, smsTemplateSchema, smsMessageSchema,
  projectSchema, projectMilestoneSchema, projectTaskSchema, projectVariationSchema, projectTimeLogSchema,
  projectDiarySchema, projectDocumentSchema, projectBaselineSchema, projectEotClaimSchema,
];
allSchemas.forEach(schema => {
  schema.set('toJSON', {
    virtuals: true,
    transform: (_, ret) => {
      ret.id = ret._id;
      ret.created_at = ret.createdAt;
      ret.updated_at = ret.updatedAt;
      return ret;
    },
  });
});

module.exports = {
  Tenant:         mongoose.model('Tenant', tenantSchema),
  Branch:         mongoose.model('Branch', branchSchema),
  User:           mongoose.model('User', userSchema),
  Category:       mongoose.model('Category', categorySchema),
  Product:        mongoose.model('Product', productSchema),
  StockMovement:  mongoose.model('StockMovement', stockMovementSchema),
  Customer:       mongoose.model('Customer', customerSchema),
  Lead:           mongoose.model('Lead', leadSchema),
  ContactHistory: mongoose.model('ContactHistory', contactHistorySchema),
  Order:          mongoose.model('Order', orderSchema),
  Supplier:       mongoose.model('Supplier', supplierSchema),
  PurchaseOrder:  mongoose.model('PurchaseOrder', purchaseOrderSchema),
  Account:        mongoose.model('Account', accountSchema),
  JournalEntry:   mongoose.model('JournalEntry', journalEntrySchema),
  Expense:        mongoose.model('Expense', expenseSchema),
  Department:     mongoose.model('Department', departmentSchema),
  Employee:       mongoose.model('Employee', employeeSchema),
  Attendance:     mongoose.model('Attendance', attendanceSchema),
  LeaveRequest:   mongoose.model('LeaveRequest', leaveRequestSchema),
  Appraisal:      mongoose.model('Appraisal', appraisalSchema),
  APPRAISAL_CATEGORIES,
  PayrollRun:     mongoose.model('PayrollRun', payrollRunSchema),
  PayrollBatch:   mongoose.model('PayrollBatch', payrollBatchSchema),
  EmployeeLoan:   mongoose.model('EmployeeLoan', employeeLoanSchema),
  LeaveType:      mongoose.model('LeaveType', leaveTypeSchema),
  PublicHoliday:  mongoose.model('PublicHoliday', publicHolidaySchema),
  TaxRate:        mongoose.model('TaxRate', taxRateSchema),
  Cart:           mongoose.model('Cart', cartSchema),
  PaymentLog:        mongoose.model('PaymentLog', paymentLogSchema),
  AuditLog:          mongoose.model('AuditLog', auditLogSchema),
  PlatformSettings:      mongoose.model('PlatformSettings', platformSettingsSchema),
  BillingTransaction:    mongoose.model('BillingTransaction', billingTransactionSchema),
  CardAuthorization:     mongoose.model('CardAuthorization', cardAuthorizationSchema),
  Budget:                mongoose.model('Budget', budgetSchema),
  Invoice:               mongoose.model('Invoice', invoiceSchema),
  CreditNote:            mongoose.model('CreditNote', creditNoteSchema),
  AccountingPeriod:      mongoose.model('AccountingPeriod', accountingPeriodSchema),
  VendorBill:            mongoose.model('VendorBill', vendorBillSchema),
  BankReconciliation:    mongoose.model('BankReconciliation', bankReconciliationSchema),
  ChatConversation:      mongoose.model('ChatConversation', chatConversationSchema),
  ChatMessage:           mongoose.model('ChatMessage', chatMessageSchema),
  Role:                  mongoose.model('Role', roleSchema),
  StorageLocation:       mongoose.model('StorageLocation', storageLocationSchema),
  AssetCategory:         mongoose.model('AssetCategory', assetCategorySchema),
  Asset:                 mongoose.model('Asset', assetSchema),
  AssetLog:              mongoose.model('AssetLog', assetLogSchema),
  PosShift:              mongoose.model('PosShift', posShiftSchema),
  PosCustomerDisplay:    mongoose.model('PosCustomerDisplay', posCustomerDisplaySchema),
  StoreCustomer:         mongoose.model('StoreCustomer', storeCustomerSchema),
  Coupon:                mongoose.model('Coupon', couponSchema),
  Promotion:             mongoose.model('Promotion', promotionSchema),
  PayoutMethod:          mongoose.model('PayoutMethod', payoutMethodSchema),
  Payout:                mongoose.model('Payout', payoutSchema),
  SmsPurchase:           mongoose.model('SmsPurchase', smsPurchaseSchema),
  SmsTemplate:           mongoose.model('SmsTemplate', smsTemplateSchema),
  SmsMessage:            mongoose.model('SmsMessage', smsMessageSchema),
  Project:               mongoose.model('Project', projectSchema),
  ProjectMilestone:      mongoose.model('ProjectMilestone', projectMilestoneSchema),
  ProjectTask:           mongoose.model('ProjectTask', projectTaskSchema),
  ProjectVariation:      mongoose.model('ProjectVariation', projectVariationSchema),
  ProjectTimeLog:        mongoose.model('ProjectTimeLog', projectTimeLogSchema),
  ProjectDiary:          mongoose.model('ProjectDiary', projectDiarySchema),
  ProjectDocument:       mongoose.model('ProjectDocument', projectDocumentSchema),
  ProjectBaseline:       mongoose.model('ProjectBaseline', projectBaselineSchema),
  ProjectEotClaim:       mongoose.model('ProjectEotClaim', projectEotClaimSchema),
};
