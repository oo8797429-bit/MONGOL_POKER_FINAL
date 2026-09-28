const express=require("express");
const cors=require("cors");
const app=express();

app.use(cors());
app.use(express.json());

const PORT=process.env.PORT||10000;

app.get("/",(req,res)=>res.json({
  ok:true,
  service:"MONGOL_POKER_SERVER",
  message:"Mongol Poker backend is running"
}));

app.get("/health",(req,res)=>res.json({
  ok:true,
  now:Date.now()
}));

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`MONGOL_POKER_SERVER listening on port ${PORT}`);
});
