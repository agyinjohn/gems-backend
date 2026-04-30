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
  plan:                    { type: String, enum: ['starter','pro','enterprise'], default: 'starter' },
  subscription_status:     { type: String, enum: ['trial','active','expired','suspended'], default: 'trial' },
  subscription_expires_at: { type: Date, default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) },
  max_branches:            { type: Number, default: 1 },
  max_users:               { type: Number, default: 5 },
  is_active:               { type: Boolean, default: true },
  card_saved:              { type: Boolean, default: false },
  trial_ends_at:           Date,
  auto_renew:              { type: Boolean, default: true },
  trial_warning_sent:      { type: Boolean, default: false },
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
  ], default: 'sales_staff' },
  is_active:            { type: Boolean, default: true },
  token_version:        { type: Number, default: 0 },
  verification_id:      String,
  verification_code:    String,
  verification_expires: Date,
}, { timestamps: true });
userSchema.index({ tenant_id: 1, email: 1 });

// CATEGORY
const categorySchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:        { type: String, required: true },
  description: String,
}, { timestamps: true });
categorySchema.index({ tenant_id: 1, name: 1 }, { unique: true });

// PRODUCT
const productSchema = new Schema({
  tenant_id:           { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  branch_id:           { type: Schema.Types.ObjectId, ref: 'Branch' },
  name:                { type: String, required: true },
  sku:                 { type: String, sparse: true },
  barcode:             { type: String, sparse: true },
  description:         String,
  category_id:         { type: Schema.Types.ObjectId, ref: 'Category' },
  price:               { type: Number, required: true, default: 0 },
  compare_price:       { type: Number, default: 0 },
  cost_price:          { type: Number, default: 0 },
  stock_qty:           { type: Number, default: 0 },
  low_stock_threshold: { type: Number, default: 10 },
  unit:                { type: String, default: 'piece' },
  images:              [String],
  is_active:           { type: Boolean, default: true },
  created_by:          { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
productSchema.index({ tenant_id: 1, sku: 1 }, { unique: true, sparse: true });

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
  payment_status:   { type: String, enum: ['pending','paid','failed','refunded'], default: 'pending' },
  status:           { type: String, enum: ['pending','processing','shipped','delivered','cancelled'], default: 'pending' },
  source:           { type: String, enum: ['storefront','internal','pos'], default: 'storefront' },
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
  status:         { type: String, enum: ['draft','pending_approval','approved','sent','partially_received','completed','cancelled'], default: 'draft' },
  payment_status: { type: String, enum: ['unpaid','paid'], default: 'unpaid' },
  paid_at:        Date,
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
  balance:     { type: Number, default: 0 },
  description: String,
  is_active:   { type: Boolean, default: true },
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
  source:       { type: String, enum: ['manual','sale','purchase','payroll'], default: 'manual' },
  source_id:    Schema.Types.ObjectId,
  entry_date:   { type: Date, default: Date.now },
  lines:        [journalLineSchema],
  created_by:   { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
journalEntrySchema.index({ tenant_id: 1, reference: 1 }, { unique: true });

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
  created_by:   { type: Schema.Types.ObjectId, ref: 'User' },
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
  employee_code: { type: String, required: true },
  name:          { type: String, required: true },
  email:         String,
  phone:         String,
  department_id: { type: Schema.Types.ObjectId, ref: 'Department' },
  job_title:     String,
  gross_salary:  { type: Number, required: true, default: 0 },
  start_date:    Date,
  status:        { type: String, enum: ['active','on_leave','terminated'], default: 'active' },
}, { timestamps: true });
employeeSchema.index({ tenant_id: 1, employee_code: 1 }, { unique: true });

// ATTENDANCE
const attendanceSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employee_id: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  date:        { type: Date, required: true },
  status:      { type: String, enum: ['present','absent','half_day','leave'], default: 'present' },
  notes:       String,
}, { timestamps: true });
attendanceSchema.index({ tenant_id: 1, employee_id: 1, date: 1 }, { unique: true });

// LEAVE REQUEST
const leaveRequestSchema = new Schema({
  tenant_id:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employee_id: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  leave_type:  { type: String, default: 'annual' },
  start_date:  { type: Date, required: true },
  end_date:    { type: Date, required: true },
  reason:      String,
  status:      { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  reviewed_by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// PAYROLL RUN
const payrollRunSchema = new Schema({
  tenant_id:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  employee_id:  { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  month:        { type: Number, required: true },
  year:         { type: Number, required: true },
  gross_salary: { type: Number, required: true },
  allowances:   { type: Number, default: 0 },
  deductions:   { type: Number, default: 0 },
  net_salary:   { type: Number, required: true },
  status:       { type: String, enum: ['draft','submitted','approved','paid'], default: 'submitted' },
  approved_by:  { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
payrollRunSchema.index({ tenant_id: 1, employee_id: 1, month: 1, year: 1 }, { unique: true });

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
  tenant_id:       { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
  plan:            { type: String, enum: ['starter','pro','enterprise'], required: true },
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

// PLATFORM SETTINGS
const platformSettingsSchema = new Schema({
  trial_days:   { type: Number, default: 14 },
  grace_days:   { type: Number, default: 7 },
  plans:        { type: Schema.Types.Mixed, default: {
    starter:    { price: 29,  max_branches: 1,   max_users: 5   },
    pro:        { price: 79,  max_branches: 5,   max_users: 20  },
    enterprise: { price: 199, max_branches: 999, max_users: 999 },
  }},
}, { timestamps: true });

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
  status:      { type: String, enum: ['success','failed'], default: 'success' },
}, { timestamps: true });
auditLogSchema.index({ tenant_id: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

// STOREFRONT CART
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

// toJSON aliases for all schemas
const allSchemas = [
  tenantSchema, branchSchema, userSchema, categorySchema, productSchema,
  stockMovementSchema, customerSchema, leadSchema, contactHistorySchema,
  orderSchema, supplierSchema, purchaseOrderSchema, accountSchema,
  journalEntrySchema, expenseSchema, departmentSchema, employeeSchema,
  attendanceSchema, leaveRequestSchema, payrollRunSchema, taxRateSchema,
  cartSchema, auditLogSchema,
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
  PayrollRun:     mongoose.model('PayrollRun', payrollRunSchema),
  TaxRate:        mongoose.model('TaxRate', taxRateSchema),
  Cart:           mongoose.model('Cart', cartSchema),
  AuditLog:          mongoose.model('AuditLog', auditLogSchema),
  PlatformSettings:      mongoose.model('PlatformSettings', platformSettingsSchema),
  BillingTransaction:    mongoose.model('BillingTransaction', billingTransactionSchema),
  CardAuthorization:     mongoose.model('CardAuthorization', cardAuthorizationSchema),
};
