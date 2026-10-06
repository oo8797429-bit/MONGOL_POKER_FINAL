const express=require('express'),cors=require('cors'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const app=express();app.use(cors());app.use(express.json({limit:'2mb'}));const PORT=process.env.PORT||10000;

const DATA_DIR=process.env.MP_DATA_DIR||(fs.existsSync('/var/data')?'/var/data':path.join(__dirname,'data')),
STATE_FILE=path.join(DATA_DIR,'mongol-poker-tables.json');

fs.mkdirSync(DATA_DIR,{recursive:true});

let tables={};
try{
  if(fs.existsSync(STATE_FILE))
    tables=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))||{};
}catch(e){console.error(e)}

function save(){
  try{
    let t=STATE_FILE+'.tmp';
    fs.writeFileSync(t,JSON.stringify(tables));
    fs.renameSync
