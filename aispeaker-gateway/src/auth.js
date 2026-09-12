'use strict';
const fs=require('fs'); const crypto=require('crypto');
const path=process.env.AUTH_FILE||'/app/data/auth.json'; const sessions=new Map();
function hash(p,s=crypto.randomBytes(16).toString('hex')){return `${s}:${crypto.scryptSync(p,s,32).toString('hex')}`}
function verify(p,v){const [s,h]=String(v||'').split(':'); if(!s||!h)return false; const x=crypto.scryptSync(p,s,32).toString('hex'); return crypto.timingSafeEqual(Buffer.from(x),Buffer.from(h));}
function load(){try{return JSON.parse(fs.readFileSync(path,'utf8'))}catch{fs.mkdirSync(require('path').dirname(path),{recursive:true}); const a={user:'admin',hash:hash('admin'),mustChange:true}; fs.writeFileSync(path,JSON.stringify(a,null,2)); return a}}
function save(a){fs.mkdirSync(require('path').dirname(path),{recursive:true}); fs.writeFileSync(path,JSON.stringify(a,null,2))}
function login(user,p){const a=load(); if(user!==a.user||!verify(p,a.hash))return null; const t=crypto.randomBytes(32).toString('hex'); sessions.set(t,{mustChange:a.mustChange,at:Date.now()}); return {t,mustChange:a.mustChange}}
function auth(req){const t=(req.headers.cookie||'').match(/sbk_session=([^;]+)/)?.[1]; return t&&sessions.get(t)?sessions.get(t):null}
function change(oldp,newp,session){const a=load(); if(!verify(oldp,a.hash)||typeof newp!=='string'||newp.length<8)return false; a.hash=hash(newp); a.mustChange=false; save(a); for(const [k] of sessions)sessions.delete(k); return true}
module.exports={load,login,auth,change};
