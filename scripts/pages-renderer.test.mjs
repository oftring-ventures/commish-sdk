import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {CreatorPageView,identifyCreatorPage} from "../packages/next/dist/pages-client.js";
import {createCreatorPage} from "../packages/next/dist/pages.js";
const require=createRequire(new URL("../packages/next/package.json",import.meta.url));
const {createElement}=require("react");
const {renderToStaticMarkup}=require("react-dom/server");
const page = {
  protocol: "commish-pages-v1",
  pageId: "cpg_123456789012",
  programId: "prg_123456789012",
  status: "ready",
  mode: "test",
  origin: "https://brand.example",
  canonicalPath: "/c/maya",
  preferredPath: "/c/maya",
  rootAliasEnabled: true,
  experimentEnabled: false,
  revision: "c0000000-0000-4000-8000-000000000001",
  creator: { handle: "maya" },
  couponCode: null,
  content: {
    brand: { name: "Brand", logoUrl: null, accentColor: "#123456" },
    headline: "Approved offer",
    description: "Description",
    productImageUrl: null,
    benefits: [],
    offer: { title: "Offer", description: "Terms" },
    cta: { label: "Shop", url: "https://brand.example/shop" },
    disclosures: ["Ad"],
  },
};

test("identity setup serializes tabs and fails closed when coordination fails",async(t)=>{
 const before=Object.getOwnPropertyDescriptor(navigator,"locks");
 t.after(()=>before?Object.defineProperty(navigator,"locks",before):delete navigator.locks);
 let tail=Promise.resolve(),cookie,created=0,active=0,max=0;
 Object.defineProperty(navigator,"locks",{configurable:true,value:{request(name,options,callback){
  assert.equal(name,"commish-pages-identity");assert(options.signal instanceof AbortSignal);
  const result=tail.then(callback);tail=result.catch(()=>{});return result;
 }}});
 const identify=async()=>{active++;max=Math.max(max,active);if(!cookie){await new Promise(r=>setTimeout(r,20));cookie=++created;}active--;return {identified:true};};
 assert.deepEqual(await Promise.all([identifyCreatorPage(identify),identifyCreatorPage(identify)]),[true,true]);
 assert.equal(created,1);assert.equal(max,1);
 assert.equal(await identifyCreatorPage(async()=>({identified:false})),false);
 assert.equal(await identifyCreatorPage(async()=>{throw Error("timeout");}),false);
 Object.defineProperty(navigator,"locks",{configurable:true,value:{request:async()=>{throw Error("acquisition timeout");}}});
 assert.equal(await identifyCreatorPage(identify),false);
 Object.defineProperty(navigator,"locks",{configurable:true,value:undefined});
 assert.equal(await identifyCreatorPage(async()=>{assert.fail("unsupported browser must not identify");}),false);
});

test("SSR escapes approved content and never records a visit or exposure", (t)=>{
 const original=globalThis.fetch; let calls=0;
 globalThis.fetch=async()=>{calls++;throw Error("SSR must not capture");};
 t.after(()=>globalThis.fetch=original);
 const ready={...page,couponCode:"MAYA",content:{...page.content,headline:"<script>unsafe</script>"}};
 const html=renderToStaticMarkup(createElement(CreatorPageView,{page:ready,integrationPath:"/api/commish/pages"}));
 assert.match(html,/&lt;script&gt;unsafe&lt;\/script&gt;/);
 assert.match(html,/Use code/);assert.doesNotMatch(html,/automatically applied/);assert.equal(calls,0);
 const ended={protocol:page.protocol,status:"ended",pageId:page.pageId,programId:page.programId,mode:page.mode,origin:page.origin,canonicalPath:page.canonicalPath,rootAliasEnabled:false,brand:page.content.brand,storeUrl:page.origin};
 const neutral=renderToStaticMarkup(createElement(CreatorPageView,{page:ended,integrationPath:"/api/commish/pages"}));
 assert.match(neutral,/offer is no longer available/);assert.doesNotMatch(neutral,/@maya|Use code/);assert.equal(calls,0);
});
test("rendering distinguishes unavailable from not found",async(t)=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 const Page=createCreatorPage({secretKey:"cm_test_sk_fixture_123456789012",programId:page.programId,origin:page.origin});
 globalThis.fetch=async()=>new Response(null,{status:503});
 assert.match(renderToStaticMarkup(await Page({params:Promise.resolve({creator:"maya"})})),/temporarily unavailable/);
 globalThis.fetch=async()=>Response.json({error:{code:"page_not_found"}},{status:404});
 await assert.rejects(()=>Page({params:Promise.resolve({creator:"maya"})}),/NEXT_HTTP_ERROR_FALLBACK;404/);
});
