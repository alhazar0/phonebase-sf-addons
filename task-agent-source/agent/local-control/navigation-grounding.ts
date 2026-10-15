import type {LocalView} from "./executor";
import type {AutonomousDecision,ObjectiveEvidence} from "./autonomous-planner";
import type {ScreenElement} from "../general-agent-contract";
import {currentAppIcon} from "./icon-library";
import {systemSearchEvidence} from "./search-dismissal";

const norm=(s:string)=>s.normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim();
type LayoutView={frame:{width:number;height:number};state:{keyboard:boolean;overlay:string};elements:ScreenElement[]};
const labels=(v:LayoutView)=>v.elements.filter(e=>e.confidence>=.65&&e.text.trim()&&!/^[\d\s:%.+°]+$/.test(e.text));
const search=(s:string)=>/^(?:q\s*)?(?:search|搜索)$/i.test(s.trim());
const catalog=(s:string)=>/^(?:q\s*)?(?:app library|应用资源库)$/i.test(s.trim());

/** OS control semantics, not an application recipe or icon-name guess. */
export function navigationLayout(view:LayoutView) {
  const es=labels(view),h=view.frame.height,w=view.frame.width;
  const catalogSearch=es.find(e=>catalog(e.text)&&e.center.y<h*.27);
  const rows:typeof es[]=[];
  for(const e of es.filter(e=>e.center.y>h*.22&&e.center.y<h*.88&&e.bounds.height<h*.035).sort((a,b)=>a.center.y-b.center.y)) {
    const row=rows.find(r=>Math.abs(r[0].center.y-e.center.y)<h*.022);
    if(row)row.push(e);else rows.push([e]);
  }
  const gridRows=rows.filter(r=>r.length>=3&&r.length<=5&&Math.max(...r.map(e=>e.center.x))-Math.min(...r.map(e=>e.center.x))>w*.28);
  const home=!view.state.keyboard&&view.state.overlay==="none"&&!catalogSearch&&gridRows.length>=3&&
    es.some(e=>search(e.text)&&e.center.y>h*.65);
  const categoryRows=rows.filter(r=>r.length===2&&Math.abs(r[0].center.x-r[1].center.x)>w*.22);
  const categoryGrid=!!catalogSearch&&!view.state.keyboard&&categoryRows.length>=2;
  const listOpen=!!catalogSearch&&es.some(e=>/^(cancel|取消)$/i.test(e.text.trim())&&e.center.y<h*.27);
  const captions=categoryGrid&&!listOpen?es.filter(e=>e.id!==catalogSearch!.id&&e.center.y>catalogSearch!.center.y+h*.08&&e.bounds.height<h*.035).map(e=>e.text):[];
  return {home,homeLabels:home?gridRows.flat().map(e=>e.text).slice(0,12):[],homeRows:home?gridRows.map(r=>r.reduce((sum,e)=>sum+e.center.y,0)/r.length):[],catalog:!!catalogSearch,
    categoryGrid:categoryGrid&&!listOpen,catalogMode:listOpen?"labeled_list":catalogSearch?"groups":null,nonInteractiveCaptions:captions,
    catalogSearchText:catalogSearch?.text??null,
    hint:listOpen?"The alphabetical app list is ALREADY OPEN. Scroll it or open a visible app; do NOT tap the search field again, which resets progress.":categoryGrid?"Category captions label groups, not individual app buttons. Tap the observed catalog search field to reveal the alphabetical app list; opening that list needs only tap, not text input. Scroll the labeled list to find an app. Do not guess an icon from a category caption.":null};
}

export function catalogEntries(view:LocalView):string[] {
  if(navigationLayout(view).catalogMode!=="labeled_list")return [];
  return labels(view).filter(e=>e.center.y>view.frame.height*.23&&e.center.y<view.frame.height*(view.state.keyboard ? 0.59 : 0.88)&&
    e.center.x>view.frame.width*.28&&e.center.x<view.frame.width*.76&&e.text.length>1&&!/^(space|search|cancel|return|done|空格|搜索|取消)$/i.test(e.text))
    .sort((a,b)=>a.center.y-b.center.y).map(e=>e.text);
}

/** Bind a grid caption to an independently detected icon ABOVE it. The hit
 * point comes from current image edges, never a fixed offset from the text. */
export function launcherIconTarget(view:LocalView,text:string) {
  const layout=navigationLayout(view);if(!layout.home)return null;
  const matches=labels(view).filter(e=>norm(e.text)===norm(text));if(matches.length!==1)return null;
  const label=matches[0],h=view.frame.height,w=view.frame.width;
  const gaps=layout.homeRows.slice(1).map((y,i)=>y-layout.homeRows[i]).sort((a,b)=>a-b);
  const rowPitch=gaps[Math.floor(gaps.length/2)];if(!rowPitch)return null;
  const icons=(view.affordances??[]).filter(c=>{
    const b=c.bounds,dy=label.center.y-c.center.y;
    return c.role==="icon"&&c.confidence>=.6&&b.width/w>=.045&&b.width/w<=.18&&b.height/h>=.025&&b.height/h<=.10&&
      b.width/b.height>=.6&&b.width/b.height<=1.6&&dy>=label.bounds.height*1.3&&dy>=b.height*.4&&dy<=b.height*1.8&&dy<rowPitch*.8&&b.top>label.center.y-rowPitch&&
      Math.abs(c.center.x-label.center.x)<=b.width*.4&&b.top+b.height<=label.bounds.top+label.bounds.height*.4;
  });
  return icons.length===1?icons[0]:null;
}

/** A catalog row's icon is LEFT of its caption, on the same observed row. */
export function catalogIconTarget(view:LocalView,text:string) {
  if(navigationLayout(view).catalogMode!=="labeled_list")return null;
  const matches=labels(view).filter(e=>norm(e.text)===norm(text));if(matches.length!==1)return null;
  const label=matches[0],w=view.frame.width,h=view.frame.height;
  const icons=(view.affordances??[]).filter(c=>{
    const b=c.bounds,gap=label.bounds.left-(b.left+b.width);
    return c.role==="icon"&&c.confidence>=.6&&b.width>w*.04&&b.width<w*.17&&b.height>h*.025&&b.height<h*.10&&
      b.width/b.height>.6&&b.width/b.height<1.6&&c.center.x<label.bounds.left&&gap>=-b.width*.2&&gap<b.width*.7&&
      Math.abs(c.center.y-label.center.y)<Math.min(b.height*.3,label.bounds.height*1.2);
  });
  return icons.length===1?icons[0]:null;
}

/** Exact-label navigation through a currently observed OS catalog. Works for
 * arbitrary names; no stored app coordinates, category guesses or input string. */
export function requestedAppName(goal:string):string|null {
  const m=goal.trim().match(/^(?:请|帮我)?\s*(?:打开|启动|open\s+|launch\s+)([^。！!?\n]{1,80})[。！!]?$/i);if(!m)return null;
  const target=m[1].trim();
  return /\b(?:and|then|after|before|inspect|check|read|view|click|navigate|send)\b/i.test(target)||/[然后再并，,；;]/.test(target)||
    /查看|进入|点击|检查|读取|浏览|返回|搜索|发送/.test(target)||(/[\u3400-\u9fff]/.test(target)&&/\s/.test(target))?null:target;
}
export function localAppDecision(goal:string,view:LocalView,objectives:ObjectiveEvidence[],resolvedTarget?:string,discoveryOnly=false):AutonomousDecision|null {
  const requested=requestedAppName(goal);if(!requested&&!(discoveryOnly&&resolvedTarget&&objectives.length))return null;
  if(view.state.overlay!=="none")return null;
  const target=resolvedTarget??requested;if(!target)return null;
  const layout=navigationLayout(view),es=labels(view),present=es.filter(e=>norm(e.text)===norm(target));
  const goalList=objectives.length?[]:[goal.trim()];
  const anchors=layout.catalog?[layout.catalogSearchText!,...(layout.categoryGrid?layout.nonInteractiveCaptions:catalogEntries(view))].slice(0,2):layout.homeLabels.slice(0,2);
  const icon=layout.categoryGrid?currentAppIcon(view,target):null;
  if(icon&&anchors.length===2)return {kind:"action",reason:"当前新画面中的图标与本机已标注样本唯一匹配；点击后仍独立验证应用页面。",objectives:goalList,requiredCapabilities:["tap"],achieved:[],finalEvidence:[],
    step:{operation:"open_app",text:target,direction:null,shape:null,beforeTexts:anchors,afterTexts:[],verification:"app_title",afterKeyboard:false,completesObjective:discoveryOnly?null:0,allowOverlay:false}};
  if((layout.catalog||layout.home&&launcherIconTarget(view,target))&&present.length===1&&!layout.nonInteractiveCaptions.some(t=>norm(t)===norm(target))&&anchors.length===2)
    return {kind:"action",reason:"本地精确应用名称匹配；点击后独立验证应用标题及新内容。",objectives:goalList,requiredCapabilities:["tap"],achieved:[],finalEvidence:[],
      step:{operation:"open_app",text:present[0].text,direction:null,shape:null,beforeTexts:anchors,afterTexts:[],verification:"app_title",afterKeyboard:false,completesObjective:discoveryOnly?null:0,allowOverlay:false}};
  // Unknown aliases/translated names still belong to the general planner.
  if(!/^[a-z0-9][a-z0-9 ._-]{3,79}$/i.test(target))return null;
  if(layout.home)return {kind:"action",reason:"当前网格没有可可靠配对的目标图标；向应用目录查找带名称的条目，不猜邻近图标。",objectives:goalList,requiredCapabilities:["swipe"],achieved:[],finalEvidence:[],
    step:{operation:"swipe",text:null,direction:"left",shape:null,beforeTexts:anchors,afterTexts:[],verification:"observe",afterKeyboard:null,completesObjective:null,allowOverlay:false}};
  if(!layout.catalog)return null;
  if(layout.catalogMode==="labeled_list"&&anchors.length===2)return {kind:"action",reason:"在已打开的字母应用列表中继续查找精确名称；不重开搜索框。",objectives:goalList,requiredCapabilities:["swipe"],achieved:[],finalEvidence:[],
    step:{operation:"swipe",text:null,direction:norm(catalogEntries(view)[0]??"").localeCompare(norm(target),"en")>0?"down":"up",shape:null,beforeTexts:anchors,afterTexts:[],verification:"observe",afterKeyboard:null,completesObjective:null,allowOverlay:false}};
  if(layout.categoryGrid){const before=[layout.catalogSearchText!,layout.nonInteractiveCaptions[0]];return {kind:"action",reason:"打开带应用名称的系统目录，不点击分类标题。",objectives:goalList,requiredCapabilities:["tap"],achieved:[],finalEvidence:[],
    step:{operation:"tap_text",text:layout.catalogSearchText!,direction:null,shape:null,beforeTexts:before,afterTexts:[],verification:"catalog",afterKeyboard:null,completesObjective:null,allowOverlay:false}};}
  return null;
}

/** Positive app-entry evidence: actual title at the top, non-launcher layout,
 * and new content, rather than remembered labels from a particular OS release. */
export function appTitleEvidence(view:LocalView,before:LocalView,title:string):string[] {
  if(view.state.overlay!=="none"||view.state.keyboard||navigationLayout(view).home||navigationLayout(view).catalog)return [];
  const es=labels(view),matches=es.filter(e=>norm(e.text)===norm(title));
  if(matches.length!==1)return [];
  const heading=matches[0],h=view.frame.height;
  if(heading.center.y>h*.29)return [];
  const preceding=es.filter(e=>e.center.y<heading.center.y-h*.035&&e.center.y>h*.13);
  if(preceding.length>1)return [];
  const old=new Set(labels(before).map(e=>norm(e.text)));
  const novel=es.filter(e=>e.id!==heading.id&&!old.has(norm(e.text))&&e.center.y>heading.center.y&&e.center.y<h*.92);
  if(!novel.length)return [];
  return [heading.text,novel[0].text];
}

/** Exact Home-only instructions bypass inference, never a compound user task. */
export function localHomeDecision(goal:string,view:LocalView,objectives:ObjectiveEvidence[]):AutonomousDecision|null {
  if(!/^(?:请|帮我)?\s*(?:返回(?:到)?|回到|回|去)?\s*(?:主页|首页|主屏幕|桌面|home)\s*[。.!！]?$/i.test(goal.trim())&&
    !/^(?:go|return|back)(?: to)? (?:the )?home(?: screen)?[.!]?$/i.test(goal.trim()))return null;
  const layout=navigationLayout(view),goalList=objectives.length?[]:[goal.trim()];
  // Let the planner use OS surface semantics (for example backdrop dismissal)
  // instead of forcing a Home primitive on every non-launcher screen.
  if(systemSearchEvidence(view))return null;
  if(layout.home){const evidence=layout.homeLabels.slice(0,2);return {kind:"complete",reason:"本地布局验证：应用网格和底部搜索入口可见。",objectives:goalList,requiredCapabilities:[],achieved:[{objective:0,evidenceTexts:evidence}],step:null,finalEvidence:evidence};}
  const anchors=labels(view).slice(0,2).map(e=>e.text);if(anchors.length<2)return null;
  if(layout.catalogMode==="groups")return {kind:"action",reason:"当前是系统应用资源库；向右滑回主屏幕，不重复无效的底部 Home 手势。",objectives:goalList,requiredCapabilities:["swipe"],achieved:[],finalEvidence:[],
    step:{operation:"swipe",text:null,direction:"right",shape:null,beforeTexts:anchors,afterTexts:[],verification:"home",afterKeyboard:false,completesObjective:0,allowOverlay:false}};
  return {kind:"action",reason:"执行设备已标定的 Home，随后验证主屏幕布局。",objectives:goalList,requiredCapabilities:["home"],achieved:[],finalEvidence:[],
    step:{operation:"home",text:null,direction:null,shape:null,beforeTexts:anchors,afterTexts:[],verification:"home",afterKeyboard:false,completesObjective:0,allowOverlay:false}};
}
