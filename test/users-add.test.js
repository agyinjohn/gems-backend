const path = require('path'); const SRC=path.join(__dirname,'../src');
const match=(d,q)=>Object.entries(q).every(([k,v])=> (v && typeof v==='object' && '$ne' in v) ? String(d[k])!==String(v.$ne) : String(d[k])===String(v));
function coll(n){const rows=[];const w=d=>d&&Object.assign(d,{save:async()=>d,toObject:()=>({...d})});return{rows,
 async findOne(q){return w(rows.find(r=>match(r,q)))||null},async countDocuments(q){return rows.filter(r=>match(r,q)).length},
 async create(d){const doc={_id:n+rows.length+1,...d};rows.push(doc);return w(doc)}};}
const models={User:coll('u'),Employee:coll('e'),Tenant:coll('t'),Department:coll('d'),Role:coll('r')};
require.cache[path.join(SRC,'models/index.js')]={loaded:true,exports:models};
require.cache[path.join(SRC,'utils/audit.js')]={loaded:true,exports:async()=>{}};
const ctl=require(path.join(SRC,'controllers/usersController.js'));
const call=async(body)=>{let s=200,j;const res={status(x){s=x;return this},json(x){j=x;return this}};await ctl.createUser({body,tenant_id:'T1',tenant:{max_users:20},user:{name:'Owner',_id:'u1'}},res);return{s,j}};
models.User.rows.push({_id:'u1',tenant_id:'T1',email:'agyinjohn100@gmail.com',name:'John Agyin',role:'business_owner'});
models.User.rows.push({_id:'u9',tenant_id:'T2',email:'other@biz.com',name:'Other'});
models.Employee.rows.push({_id:'e1',tenant_id:'T1',name:'John Agyin',email:'agyinjohn100@gmail.com',status:'active'});
models.Employee.rows.push({_id:'e2',tenant_id:'T1',name:'Ama',email:'other@biz.com',status:'active'});
(async()=>{
 let r=await call({employee_id:'e1',password:'Valid#Pass1',role:'sales_staff'});
 console.log(r.s===200&&r.j.linked&&models.Employee.rows[0].user_id==='u1'?'PASS':'FAIL','owner-as-employee linked:',r.j.message);
 r=await call({employee_id:'e2',password:'Valid#Pass1',role:'sales_staff'});
 console.log(r.s===409?'PASS':'FAIL','email used in another business:',r.j.message);
 r=await call({name:'Dup',email:'AGYINJOHN100@gmail.com',password:'Valid#Pass1',role:'sales_staff'});
 console.log(r.s===409?'PASS':'FAIL','same-business duplicate, no employee:',r.j.message);
 r=await call({name:'New',email:'new@x.com',password:'Valid#Pass1',role:'sales_staff'});
 console.log(r.s===201?'PASS':'FAIL','new email still creates:',r.j.message);
})();
(async()=>{ await new Promise(r=>setTimeout(r,300)); const r=await call({name:'Weak',email:'weak@x.com',password:'abc',role:'sales_staff'}); console.log(r.s===400&&/8 characters/.test(r.j.message)?'PASS':'FAIL','staff password policy enforced:',r.j.message); })();
