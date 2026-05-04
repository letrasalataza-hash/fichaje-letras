import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { jsPDF } from 'jspdf';
import './styles.css';

const SUPABASE_URL = 'https://rwebxeboopnqlzrnlslb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3ZWJ4ZWJvb3BucWx6cm5sc2xiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjg5NzEsImV4cCI6MjA5Mjg0NDk3MX0.utDIvdUqV1yvegQEn7B82FHnM5onJm_l0Pi1DneBWZI';
const ADMIN_CODE = '3773';
const PIN_SALT = 'letras-a-la-taza-control-horario-v1';
const SIGNATURE_SALT = 'letras-a-la-taza-firma-informes-v1';

const labels = {
  entrada: 'Entrada',
  salida: 'Salida',
  pausa_inicio: 'Inicio pausa',
  pausa_fin: 'Fin pausa',
  ajuste: 'Ajuste manual',
};
const adjustmentLabels = {
  entrada: 'Entrada olvidada', salida: 'Salida olvidada', pausa_inicio: 'Pausa olvidada', pausa_fin: 'Fin pausa olvidado'
};
const todayISO = (d = new Date()) => d.toISOString().slice(0, 10);
const monthISO = (d = new Date()) => d.toISOString().slice(0, 7);
const fmtTime = d => new Date(d).toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'});
const fmtDateTime = d => new Date(d).toLocaleString('es-ES', {dateStyle:'short', timeStyle:'short'});
const mins = n => `${Math.floor(Math.max(0, Math.round(n || 0))/60)}h ${String(Math.max(0, Math.round(n || 0))%60).padStart(2,'0')}min`;
const cleanFile = s => String(s||'documento').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'documento';

async function sha256(text){
  const data = new TextEncoder().encode(String(text ?? ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
const hashPin = pin => sha256(`${PIN_SALT}:${String(pin ?? '').trim()}`);
const probablyHash = v => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);
async function verifyPin(pin, stored){ if(!stored) return false; return probablyHash(stored) ? (await hashPin(pin))===stored : String(pin).trim()===String(stored).trim(); }
async function signReport(payload){ const h = await sha256(`${SIGNATURE_SALT}:${JSON.stringify(payload)}`); return {hash:h, short:h.slice(0,12).toUpperCase(), at:fmtDateTime(new Date()), by:payload.generatedBy}; }

async function api(path, options={}){
  const res = await fetch(`${SUPABASE_URL.replace(/\/+$/,'')}/rest/v1/${path.replace(/^\/+/, '')}`, {
    ...options,
    headers: {apikey:SUPABASE_ANON_KEY, Authorization:`Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type':'application/json', Prefer:'return=representation', ...(options.headers||{})}
  });
  const txt = await res.text();
  const data = txt ? JSON.parse(txt) : null;
  if(!res.ok) throw new Error(data?.message || data?.hint || res.statusText);
  return data;
}
function parseAdj(note=''){
  const m = String(note).match(/^Ajuste manual \[(entrada|salida|pausa_inicio|pausa_fin)\] · (.+)$/);
  return m ? {effectiveType:m[1], note:m[2]} : {effectiveType:null, note};
}
function mapRecord(r, employees){
  const emp = employees.find(e=>e.id===r.employee_id);
  const parsed = r.record_type==='ajuste' ? parseAdj(r.note || '') : {effectiveType:null, note:r.note||''};
  const eff = parsed.effectiveType;
  return { id:r.id, employeeId:r.employee_id, employeeName:emp?.name || 'Empleado', type:r.record_type, effectiveType:eff, label:r.record_type==='ajuste' ? `Ajuste manual${eff ? ' ('+adjustmentLabels[eff]+')':''}` : (labels[r.record_type]||r.record_type), date:r.local_date || r.recorded_at.slice(0,10), time:fmtTime(r.recorded_at), createdAt:new Date(r.recorded_at).getTime(), note:parsed.note, createdBy:r.created_by || (r.record_type==='ajuste'?'Admin':'Sistema') };
}
function summary(records){
  const ordered = [...records].map(r=>({...r, calc:r.effectiveType||r.type})).sort((a,b)=>a.createdAt-b.createdAt);
  let start=null, pause=null, work=0, rest=0; const warnings=[];
  for(const r of ordered){
    if(r.calc==='entrada'){ if(start) warnings.push('Hay una entrada sin salida antes de otra entrada.'); start=r.createdAt; }
    if(r.calc==='pausa_inicio'){ if(!start) warnings.push('Pausa sin entrada previa.'); if(pause) warnings.push('Pausa iniciada dos veces.'); pause=r.createdAt; }
    if(r.calc==='pausa_fin'){ if(!pause) warnings.push('Fin de pausa sin pausa abierta.'); else { rest += (r.createdAt-pause)/60000; pause=null; } }
    if(r.calc==='salida'){ if(!start) warnings.push('Salida sin entrada previa.'); else { work += (r.createdAt-start)/60000; start=null; } if(pause){ warnings.push('Salida mientras la pausa estaba abierta.'); pause=null; } }
  }
  if(start) warnings.push('Entrada abierta sin salida.'); if(pause) warnings.push('Pausa abierta sin volver.');
  const adjustments = records.filter(r=>r.type==='ajuste').length; if(adjustments) warnings.push(`Hay ${adjustments} ajuste(s) manual(es).`);
  return {gross:work, breaks:rest, net:Math.max(0, work-rest), count:records.length, adjustments, warnings:[...new Set(warnings)]};
}
function monthSummary(records){
  const byDay={}; records.forEach(r=>{(byDay[r.date]??=[]).push(r);});
  const days = Object.entries(byDay).sort(([a],[b])=>a.localeCompare(b)).map(([date, recs])=>({date, recs, s:summary(recs)}));
  const totals = days.reduce((a,d)=>({net:a.net+d.s.net, breaks:a.breaks+d.s.breaks, count:a.count+d.s.count, adjustments:a.adjustments+d.s.adjustments}), {net:0,breaks:0,count:0,adjustments:0});
  return {days, totals};
}
function seqIssues(existing, nr){
  const arr=[...existing,nr].map(r=>({...r, calc:r.effectiveType||r.type})).sort((a,b)=>a.createdAt-b.createdAt); let state='fuera'; const out=[];
  for(const r of arr){ const label=`${r.date} ${r.time}`;
    if(r.calc==='entrada'){ if(state==='trabajando') out.push(`${label}: entrada cuando ya estaba trabajando.`); if(state==='pausa') out.push(`${label}: entrada con pausa abierta.`); state='trabajando'; }
    if(r.calc==='pausa_inicio'){ if(state==='fuera') out.push(`${label}: pausa sin entrada.`); if(state==='pausa') out.push(`${label}: pausa duplicada.`); state='pausa'; }
    if(r.calc==='pausa_fin'){ if(state!=='pausa') out.push(`${label}: fin de pausa sin pausa.`); state='trabajando'; }
    if(r.calc==='salida'){ if(state==='fuera') out.push(`${label}: salida sin entrada.`); if(state==='pausa') out.push(`${label}: salida con pausa abierta.`); state='fuera'; }
  }
  return [...new Set(out)];
}
function Card({children}){return <div className="card">{children}</div>}
function Button({children, ...p}){return <button {...p} className={`btn ${p.className||''}`}>{children}</button>}

function pdfReport(report){
  const doc=new jsPDF({unit:'mm',format:'a4'}); let y=18;
  doc.setFont('helvetica','bold'); doc.setFontSize(18); doc.text('Letras a la Taza',15,y); y+=8;
  doc.setFontSize(14); doc.text(report.title,15,y); y+=8; doc.setFont('helvetica','normal'); doc.setFontSize(10);
  doc.text(`Empleado: ${report.employee}`,15,y); y+=6; doc.text(`Periodo: ${report.period}`,15,y); y+=8;
  report.cards.forEach(([k,v])=>{ doc.setFont('helvetica','bold'); doc.text(`${k}:`,15,y); doc.setFont('helvetica','normal'); doc.text(String(v),60,y); y+=6; });
  y+=3; if(report.warnings.length){ doc.setFont('helvetica','bold'); doc.text('Incidencias / avisos',15,y); y+=6; doc.setFont('helvetica','normal'); report.warnings.forEach(w=>{ const lines=doc.splitTextToSize('• '+w,175); doc.text(lines,18,y); y+=lines.length*5; }); }
  if(report.signature){ y+=4; doc.setFont('helvetica','bold'); doc.text('Firma y trazabilidad',15,y); y+=6; doc.setFont('helvetica','normal'); doc.text(`Código: ${report.signature.short}`,15,y); y+=5; doc.text(`Generado por: ${report.signature.by}`,15,y); y+=5; doc.text(`Generado en: ${report.signature.at}`,15,y); y+=5; doc.text(doc.splitTextToSize(`Hash SHA-256: ${report.signature.hash}`,175),15,y); y+=12; }
  doc.setFont('helvetica','bold'); doc.text('Detalle',15,y); y+=6; doc.setFont('helvetica','normal'); doc.setFontSize(8);
  report.rows.forEach(row=>{ if(y>275){doc.addPage(); y=18;} doc.text(doc.splitTextToSize(row.join(' | '),180),15,y); y+=8; });
  y=Math.min(y+18,280); doc.line(20,y,90,y); doc.line(120,y,190,y); y+=5; doc.text('Firma empresa / responsable',20,y); doc.text('Firma trabajador/a',120,y);
  doc.save(report.fileName);
}
function csv(records){ const rows=[['Empleado','Tipo','Fecha','Hora','Nota','Creado por'],...records.map(r=>[r.employeeName,r.label,r.date,r.time,r.note,r.createdBy])]; const txt=rows.map(r=>r.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\n'); const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([txt],{type:'text/csv'})); a.download='fichajes.csv'; a.click(); }

function App(){
  const [employees,setEmployees]=useState([]); const [selected,setSelected]=useState(''); const [pin,setPin]=useState(''); const [records,setRecords]=useState([]); const [msg,setMsg]=useState('Cargando...'); const [loading,setLoading]=useState(false); const [mode,setMode]=useState('kiosk'); const [admin,setAdmin]=useState(false);
  const [newName,setNewName]=useState(''); const [newPin,setNewPin]=useState(''); const [day,setDay]=useState(todayISO()); const [mon,setMon]=useState(monthISO()); const [adminName,setAdminName]=useState('Admin'); const [adjType,setAdjType]=useState('salida'); const [adjDate,setAdjDate]=useState(todayISO()); const [adjTime,setAdjTime]=useState('12:00'); const [adjNote,setAdjNote]=useState(''); const [resetId,setResetId]=useState(''); const [resetPin,setResetPin]=useState(''); const [test,setTest]=useState(false);
  const selectedEmployee=employees.find(e=>e.id===selected); const dayRecords=useMemo(()=>records.filter(r=>r.employeeId===selected&&r.date===day),[records,selected,day]); const monthRecords=useMemo(()=>records.filter(r=>r.employeeId===selected&&r.date.startsWith(mon)),[records,selected,mon]); const s=useMemo(()=>summary(dayRecords),[dayRecords]); const ms=useMemo(()=>monthSummary(monthRecords),[monthRecords]);
  useEffect(()=>{ test ? loadTest() : loadData(); },[test]);
  async function loadData(){ setLoading(true); try{ const er=await api('employees?select=id,organization_id,full_name,pin_hash&or=(is_active.is.null,is_active.eq.true)&order=full_name.asc'); const em=er.map(e=>({id:e.id, organizationId:e.organization_id, name:e.full_name, pin:e.pin_hash})); setEmployees(em); setSelected(v=>v||em[0]?.id||''); let rr; try{rr=await api('time_records?select=id,employee_id,record_type,recorded_at,local_date,note,created_by&order=recorded_at.desc&limit=800')}catch{rr=await api('time_records?select=id,employee_id,record_type,recorded_at,local_date&order=recorded_at.desc&limit=800')} setRecords(rr.map(r=>mapRecord(r,em))); setMsg('Datos cargados.'); }catch(e){setMsg('Error cargando Supabase: '+e.message)} finally{setLoading(false)} }
  function loadTest(){ const em=[{id:'1',organizationId:'org1',name:'Miguel Iglesias',pin:'1234'},{id:'2',organizationId:'org1',name:'Equipo Librería',pin:'2222'}]; const t=todayISO(); const rs=[['entrada','09:00'],['pausa_inicio','11:00'],['pausa_fin','11:15'],['salida','14:00']].map(([type,time],i)=>({id:'r'+i,employeeId:'1',employeeName:'Miguel Iglesias',type,label:labels[type],date:t,time,createdAt:new Date(`${t}T${time}:00`).getTime(),note:'',createdBy:'Sistema'})); setEmployees(em); setSelected('1'); setRecords(rs); setMsg('Modo prueba activado.'); }
  function handlePin(v){ setPin(v); if(!selected && v.trim()===ADMIN_CODE){ setAdmin(true); setMode('admin'); setPin(''); setMsg('Panel admin desbloqueado.'); } }
  async function addRecord(type){ if(!selectedEmployee) return setMsg('Selecciona empleado.'); if(!(await verifyPin(pin,selectedEmployee.pin))) return setMsg('PIN incorrecto.'); const now=new Date(); const nr={id:'local-'+Date.now(),employeeId:selectedEmployee.id,employeeName:selectedEmployee.name,type,label:labels[type],date:todayISO(now),time:fmtTime(now),createdAt:now.getTime(),note:'',createdBy:'Sistema'}; const issues=seqIssues(dayRecords,nr); if(test){setRecords(r=>[nr,...r]); setPin(''); return setMsg(issues.length?`${labels[type]} con aviso: ${issues[0]}`:`${labels[type]} registrado.`)} setLoading(true); try{ const ins=await api('time_records',{method:'POST',body:JSON.stringify({organization_id:selectedEmployee.organizationId,employee_id:selectedEmployee.id,record_type:type,local_date:todayISO(),source:'app'})}); const rec=mapRecord(ins[0],employees); setRecords(r=>[rec,...r]); setPin(''); setMsg(issues.length?`${labels[type]} con aviso: ${issues[0]}`:`${labels[type]} registrado.`); }catch(e){setMsg('Error guardando: '+e.message)} finally{setLoading(false)} }
  async function addEmployee(){ if(!newName.trim()||!/^\d{4,8}$/.test(newPin.trim())) return setMsg('Nombre y PIN de 4 a 8 números.'); const pin_hash=await hashPin(newPin); if(test){ const emp={id:'e'+Date.now(),organizationId:'org1',name:newName.trim(),pin:pin_hash}; setEmployees(e=>[...e,emp]); setNewName(''); setNewPin(''); return setMsg('Empleado de prueba añadido.'); } setLoading(true); try{ const org=(await api('organizations?select=id&limit=1'))[0]?.id; const ins=await api('employees',{method:'POST',body:JSON.stringify({organization_id:org,full_name:newName.trim(),pin_hash,is_active:true})}); const emp={id:ins[0].id,organizationId:ins[0].organization_id,name:ins[0].full_name,pin:ins[0].pin_hash}; setEmployees(e=>[...e,emp]); setNewName(''); setNewPin(''); setMsg('Empleado añadido.'); }catch(e){setMsg('Error creando empleado: '+e.message)} finally{setLoading(false)} }
  async function baja(id){ const emp=employees.find(e=>e.id===id); if(!emp||!confirm(`¿Dar de baja a ${emp.name}?`)) return; if(test){setEmployees(e=>e.filter(x=>x.id!==id)); return;} try{await api(`employees?id=eq.${id}`,{method:'PATCH',body:JSON.stringify({is_active:false})}); setEmployees(e=>e.filter(x=>x.id!==id)); setMsg('Empleado dado de baja.');}catch(e){setMsg('Error baja: '+e.message)} }
  async function reset(){ if(!resetId||!/^\d{4,8}$/.test(resetPin)) return setMsg('Nuevo PIN inválido.'); const h=await hashPin(resetPin); if(test){setEmployees(e=>e.map(x=>x.id===resetId?{...x,pin:h}:x)); setResetId(''); setResetPin(''); return;} try{await api(`employees?id=eq.${resetId}`,{method:'PATCH',body:JSON.stringify({pin_hash:h})}); setEmployees(e=>e.map(x=>x.id===resetId?{...x,pin:h}:x)); setResetId(''); setResetPin(''); setMsg('PIN restablecido.');}catch(e){setMsg('Error PIN: '+e.message)} }
  async function adjustment(){ if(!selectedEmployee||!adjNote.trim()) return setMsg('Selecciona empleado y motivo.'); const dt=new Date(`${adjDate}T${adjTime}:00`); const note=`Ajuste manual [${adjType}] · ${adjustmentLabels[adjType]}: ${adjNote.trim()}`; const nr={id:'adj'+Date.now(),employeeId:selectedEmployee.id,employeeName:selectedEmployee.name,type:'ajuste',effectiveType:adjType,label:`Ajuste manual (${adjustmentLabels[adjType]})`,date:adjDate,time:adjTime,createdAt:dt.getTime(),note:parseAdj(note).note,createdBy:adminName}; const issues=seqIssues(records.filter(r=>r.employeeId===selected&&r.date===adjDate),nr); if(test){setRecords(r=>[nr,...r]); setAdjNote(''); return setMsg(issues.length?'Ajuste con aviso: '+issues[0]:'Ajuste registrado.')} try{const ins=await api('time_records',{method:'POST',body:JSON.stringify({organization_id:selectedEmployee.organizationId,employee_id:selectedEmployee.id,record_type:'ajuste',local_date:adjDate,recorded_at:dt.toISOString(),source:'admin_adjustment',note,created_by:adminName})}); setRecords(r=>[{...mapRecord(ins[0],employees), effectiveType:adjType, date:adjDate, time:adjTime, createdAt:dt.getTime(), note:parseAdj(note).note, createdBy:adminName},...r]); setAdjNote(''); setMsg(issues.length?'Ajuste con aviso: '+issues[0]:'Ajuste registrado.')}catch(e){setMsg('Error ajuste: '+e.message)} }
  async function report(kind){ const employee=selectedEmployee?.name||'Empleado'; const isMonth=kind==='month'; const data=isMonth?ms:s; const recs=isMonth?monthRecords:dayRecords; const signature=await signReport({kind, employee, period:isMonth?mon:day, totals:data, records:recs.map(r=>({id:r.id,type:r.type,at:r.createdAt,note:r.note})), generatedBy:adminName}); const cards=isMonth ? [['Trabajo neto mensual',mins(ms.totals.net)],['Pausas',mins(ms.totals.breaks)],['Registros',ms.totals.count],['Ajustes',ms.totals.adjustments]] : [['Trabajo neto',mins(s.net)],['Pausas',mins(s.breaks)],['Registros',s.count],['Ajustes',s.adjustments]]; const warnings=isMonth?ms.days.flatMap(d=>d.s.warnings.map(w=>`${d.date}: ${w}`)):s.warnings; const rows=isMonth?ms.days.map(d=>[d.date,mins(d.s.net),mins(d.s.breaks),d.s.count,d.s.adjustments,d.s.warnings.join(' · ')||'Sin incidencias']):dayRecords.map(r=>[r.employeeName,r.label,r.time,r.date,r.note,r.createdBy]); pdfReport({title:isMonth?'Informe mensual de fichaje':'Informe diario de fichaje', employee, period:isMonth?mon:day, cards, warnings, rows, signature, fileName:`informe-${isMonth?'mensual':'diario'}-${cleanFile(employee)}-${isMonth?mon:day}.pdf`}); setMsg('PDF generado. Código: '+signature.short); }
  const timeline=[...dayRecords].sort((a,b)=>a.createdAt-b.createdAt);
  return <main><header><div><small>Letras a la Taza</small><h1>Control horario y fichaje</h1><p>{mode==='kiosk'?'Modo kiosko':'Panel admin'}</p></div><div><Button onClick={()=>setTest(!test)}>{test?'Salir prueba':'Modo prueba'}</Button>{admin&&<><Button onClick={()=>setMode('kiosk')}>Kiosko</Button><Button onClick={()=>setMode('admin')}>Admin</Button><Button onClick={()=>{setAdmin(false);setMode('kiosk')}}>Bloquear</Button></>}</div></header>
  {mode==='kiosk'&&<Card><h2>Fichar turno</h2><p>Deja empleado sin seleccionar y escribe 3773 en PIN para entrar en admin.</p><div className="grid2"><label>Empleado<select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Selecciona empleado</option>{employees.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label><label>PIN<input type="password" value={pin} onChange={e=>handlePin(e.target.value)} placeholder="PIN" /></label></div><div className="status"><b>{selectedEmployee?.name||'Sin empleado seleccionado'}</b><span>{mins(s.net)} trabajadas hoy · {mins(s.breaks)} pausa</span></div><div className="buttons"><Button onClick={()=>addRecord('entrada')}>Entrada</Button><Button onClick={()=>addRecord('pausa_inicio')}>Pausa</Button><Button onClick={()=>addRecord('pausa_fin')}>Volver</Button><Button onClick={()=>addRecord('salida')}>Salida</Button></div><p className="msg">{loading?'Trabajando... ':''}{msg}</p></Card>}
  {mode==='admin'&&admin&&<><Card><h2>Responsable</h2><input value={adminName} onChange={e=>setAdminName(e.target.value)} /></Card><div className="grid2"><Card><h2>Añadir empleado</h2><input placeholder="Nombre" value={newName} onChange={e=>setNewName(e.target.value)} /><input placeholder="PIN 4-8 números" value={newPin} onChange={e=>setNewPin(e.target.value)} /><Button onClick={addEmployee}>Añadir</Button></Card><Card><h2>Equipo</h2>{employees.map(e=><div className="employee" key={e.id}><button onClick={()=>setSelected(e.id)}>{e.name}</button><button onClick={()=>setResetId(e.id)}>Cambiar PIN</button><button onClick={()=>baja(e.id)}>Baja</button></div>)}</Card></div>{resetId&&<Card><h2>Restablecer PIN</h2><input type="password" value={resetPin} onChange={e=>setResetPin(e.target.value)} placeholder="Nuevo PIN"/><Button onClick={reset}>Guardar PIN</Button></Card>}<Card><h2>Ajustes manuales</h2><div className="grid5"><select value={adjType} onChange={e=>setAdjType(e.target.value)}>{Object.entries(adjustmentLabels).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select><input type="date" value={adjDate} onChange={e=>setAdjDate(e.target.value)} /><input type="time" value={adjTime} onChange={e=>setAdjTime(e.target.value)} /><input placeholder="Motivo" value={adjNote} onChange={e=>setAdjNote(e.target.value)} /><Button onClick={adjustment}>Registrar</Button></div></Card><Card><h2>Timeline del día</h2><div className="summary"><b>{mins(s.net)}</b><span>Pausas {mins(s.breaks)}</span><span>Ajustes {s.adjustments}</span></div>{s.warnings.map(w=><p className="warn" key={w}>⚠ {w}</p>)}{timeline.length?timeline.map((r,i)=><div className="line" key={r.id}><b>{r.time}</b><span>{r.label}</span><small>{r.note}</small>{timeline[i+1]&&<em>{mins((timeline[i+1].createdAt-r.createdAt)/60000)} hasta {timeline[i+1].time}</em>}</div>):<p>Sin registros.</p>}</Card><Card><h2>Historial e informes</h2><div className="grid2"><label>Empleado<select value={selected} onChange={e=>setSelected(e.target.value)}>{employees.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label><label>Día<input type="date" value={day} onChange={e=>setDay(e.target.value)} /></label><label>Mes<input type="month" value={mon} onChange={e=>setMon(e.target.value)} /></label></div><div className="buttons"><Button onClick={loadData}>Recargar</Button><Button onClick={()=>csv(dayRecords)}>CSV</Button><Button onClick={()=>report('day')}>PDF día</Button><Button onClick={()=>report('month')}>PDF mes</Button></div><table><thead><tr><th>Empleado</th><th>Tipo</th><th>Hora</th><th>Fecha</th><th>Nota</th></tr></thead><tbody>{dayRecords.map(r=><tr key={r.id}><td>{r.employeeName}</td><td>{r.label}</td><td>{r.time}</td><td>{r.date}</td><td>{r.note||'—'}</td></tr>)}</tbody></table></Card></>}
  </main>
}

createRoot(document.getElementById('root')).render(<App />);
