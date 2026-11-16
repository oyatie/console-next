// SPDX-License-Identifier: LicenseRef-Proprietary
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";
import { loadCatalog } from "@console/i18n";
import { browserTestOptimizeDeps, browserEngine } from "../apps/web/src/lib/browser-test";

export async function tableTest() {
  await loadCatalog("ko");
  const server = await createServer({
    configFile: false, cacheDir: ".cache/long-table-test", logLevel: "error",
    define: { "process.env.VIRT_ON": "true" }, optimizeDeps: browserTestOptimizeDeps,
    resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, fs: { allow: [resolve("."), realpathSync("node_modules/pretendard")] } },
    plugins: [{
      name: "long-table-test",
      resolveId: id => id === "/long-table-test.js" ? "\0long-table-test" : undefined,
      load: id => id === "\0long-table-test" ? `
        import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
        import {loadCatalog} from '@console/i18n';
        import {LongTable,TableControl} from '/apps/web/src/ui/long-table/long-table.tsx';
        import {Button} from '/apps/web/src/ui/button/button.tsx';
        import {TextInput} from '/apps/web/src/ui/field/field.tsx';
        import {NO_SELECTION} from '/apps/web/src/ui/long-table/selection.ts';
        import '/apps/web/src/app.css';
        await loadCatalog('ko');
        function Fixture(){
          const navigation=location.search.match(/^\\?navigation-(cell|button|input)(-wrapped)?$/);
          if(navigation) return React.createElement(LongTable,{
            label:'키보드 탐색',rows:[{id:'a',name:'Alpha'},{id:'b',name:'Beta'},{id:'c',name:'Gamma'}],rowId:r=>r.id,
            empty:null,hasMore:false,onLoadMore:()=>{},selection:NO_SELECTION,onSelectionChange:()=>{},
            columns:[{id:'name',header:'이름',rowHeader:true,card:'title',cell:r=>r.name},
              {id:'control',header:'작업',card:'action',focusMode:navigation[1]==='cell'?'cell':'child',cell:r=>{
                const child=navigation[1]==='cell'?r.name:navigation[1]==='button'
                  ?React.createElement(Button,{'aria-label':r.name,onClick:()=>document.body.dataset.pressed=r.id},r.name)
                  :React.createElement(TableControl,null,React.createElement(TextInput,{'aria-label':r.name,defaultValue:'abcdef',onKeyDown:e=>requestAnimationFrame(()=>document.body.dataset.inputPrevented=String(e.defaultPrevented))}));
                return navigation[2]?React.createElement('span',null,child):child;
              }},
              {id:'last',header:'메모',card:'fact',cell:()=>'-'}]
          });
          const editing=location.search.startsWith('?typing');
          const [values,setValues]=useState({});
          const [sort,setSort]=useState({column:'name',direction:'ascending'});
          const [selection,setSelection]=useState(NO_SELECTION);
          const collision=location.search.startsWith('?collision');
          const keyboardOpen=location.search==='?keyboard-open';
          const targets=location.search.startsWith('?targets');
          const stopKey=e=>{if(e.key==='Enter'||e.key===' ')e.stopPropagation();};
          const action=React.createElement(Button,{className:location.search==='?targets-tiny'?'tiny':undefined,size:'sm',onKeyDown:stopKey,onKeyUp:stopKey,onClick:e=>{e.stopPropagation();document.body.dataset.pressed='true';}},'지정');
          const rows=editing ? [{id:'a',name:'Alpha'},{id:'b',name:'Beta'},{id:'ko',name:'ㄱ가상'}] : collision||keyboardOpen ? ['name','__select','__card','row:name'].map((id,i)=>({id,name:'가상'+i,note:id}))
            : [{id:'a',name:'가상가',note:'첫째'},{id:'b',name:'가상나',note:'둘째'}];
          return React.createElement(LongTable,{
            density:targets?'compact':undefined,
            label:'정렬 검증',rows,rowId:r=>r.id,empty:null,hasMore:false,onLoadMore:()=>{},
            ...(targets ? {selection,onSelectionChange:setSelection,onRowAction:id=>document.body.dataset.action=id} : {}),
            editable:location.search==='?typing-editable',
            caption:sort.column+':'+sort.direction,
            sortDescriptor:sort,onSortChange:location.search==='?readonly'?undefined:setSort,
            ...(collision||keyboardOpen ? {...(location.search==='?collision' ? {selection,onSelectionChange:s=>{setSelection(s);document.body.dataset.selection=JSON.stringify(s.kind==='ids'?[...s.ids]:[...s.excluded]);}} : {}),
              rowKeys:keyboardOpen?{onOpen:id=>document.body.dataset.keyboardOpen=id}:{},...(keyboardOpen?{}:{onRowAction:id=>document.body.dataset.action=id}),
              onRowFocus:id=>document.body.dataset.focus=id,onRowHover:id=>document.body.dataset.hover=id} : {}),
            columns:[{id:'name',header:'이름',card:editing||location.search==='?rows'?undefined:'title',rowHeader:true,allowsSorting:true,focusMode:location.search.endsWith('-arrows')?'child':undefined,cell:r=>location.search.endsWith('-arrows') ? React.createElement(Button,{size:'sm',onKeyDown:stopKey,onKeyUp:stopKey,onClick:e=>{e.stopPropagation();document.body.dataset.pressed='true';}},r.name) : r.name},
              {id:'note',header:'메모',allowsSorting:true,focusMode:location.search==='?typing-child'?'child':undefined,cell:r=>editing ? React.createElement(TableControl,null,React.createElement(TextInput,{'aria-label':r.name+' 메모',value:values[r.id]??'',onChange:e=>setValues(v=>({...v,[r.id]:e.target.value}))})) : r.note},
              {id:'fixed',header:'고정',type:targets?'action':undefined,width:targets?160:undefined,cell:()=>targets ? (location.search.startsWith('?targets-wrapped') ? React.createElement('span',null,action) : action) : '-'}]
          });
        }
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));
      ` : undefined,
      configureServer: vite => { vite.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/long-table-test") return next();
        res.setHeader("Content-Type", "text/html");
        res.end('<html lang="ko"><title>Table</title><style>.tiny { min-width:0; min-height:0; width:16px; height:16px; padding:0; }</style><div id="root"></div><button class="btn" id="after-table">다음</button><script type="module" src="/long-table-test.js"></script></html>');
      }); },
    }],
  });
  await server.listen();
  const browser = await browserEngine().launch();
  const page = await (await browser.newContext()).newPage();
  return { server, browser, page };
}
