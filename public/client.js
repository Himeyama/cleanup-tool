/* ==== クライアント状態 ==== */
var ROWH = 44, OVERSCAN = 8;
var IMG_EXTS = ['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.tiff','.tif'];
var FULLQ_EXTS = ['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.svg']; // ブラウザが原寸表示できる（tiff除く）
var VID_EXTS = ['.mp4','.m4v','.webm','.ogv','.mov','.mkv','.avi','.wmv','.flv'];
var records = [];          // 全 ScanResult
var view = [];             // 表示用 FilteredResult[]（ソート後）
var byId = Object.create(null);
var selected = new Set();
var sortKey = 'size', sortDir = -1;
var filterSpec = {};
var deleteMode = 'permanent';
var scanState = 'idle';
var rebuildScheduled = false;
var mode = 'junk';         // 'junk' | 'duplicate'
var dupGroups = [];        // [{kind, files:[record], keepId}]
var dupRenderScheduled = false;

var $ = function(id){ return document.getElementById(id); };
function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function humanSize(n){
  if(!isFinite(n)||n<0) return '0 B';
  if(n<1024) return n+' B';
  var u=['KB','MB','GB','TB','PB'], i=-1;
  do{ n/=1024; i++; }while(n>=1024 && i<u.length-1);
  return n.toFixed(2)+' '+u[i];
}
function fmtDate(ms){ if(!ms) return ''; var d=new Date(ms); return d.toLocaleDateString()+' '+d.toLocaleTimeString().slice(0,5); }

/* ==== カテゴリUI ==== */
var CATEGORIES = [];
function renderCats(){
  var html='';
  for(var i=0;i<CATEGORIES.length;i++){
    var c=CATEGORIES[i];
    html+='<label class="cat"><input type="checkbox" class="catchk" value="'+c+'"'+(i<2?' checked':'')+'>'
      +'<span>'+c+'</span><span class="cnt" id="cnt-'+c+'">0</span></label>';
  }
  $('cats').innerHTML=html;
}
function selectedCategories(){
  return Array.prototype.slice.call(document.querySelectorAll('.catchk'))
    .filter(function(e){return e.checked;}).map(function(e){return e.value;});
}
function updateCatCounts(){
  var counts=Object.create(null);
  for(var i=0;i<records.length;i++){ var c=records[i].category; counts[c]=(counts[c]||0)+1; }
  for(var j=0;j<CATEGORIES.length;j++){ var el=$('cnt-'+CATEGORIES[j]); if(el) el.textContent=counts[CATEGORIES[j]]||0; }
}

/* ==== ソート・ビュー構築 ==== */
function rebuildView(){
  view = records.slice();
  var k=sortKey, d=sortDir;
  view.sort(function(a,b){
    var va=a[k], vb=b[k];
    if(typeof va==='string'){ va=va.toLowerCase(); vb=(vb||'').toLowerCase(); }
    if(va<vb) return -1*d; if(va>vb) return 1*d; return 0;
  });
  renderList();
  updateCatCounts();
  updateStatus();
}
function scheduleRebuild(){
  if(rebuildScheduled) return;
  rebuildScheduled=true;
  requestAnimationFrame(function(){ rebuildScheduled=false; rebuildView(); });
}

/* ==== 仮想スクロール ==== */
var viewport=$('viewport'), sizer=$('sizer'), rowsEl=$('rows');
function renderList(){
  var total=view.length;
  sizer.style.height=(total*ROWH)+'px';
  var st=viewport.scrollTop, vh=viewport.clientHeight;
  var start=Math.max(0, Math.floor(st/ROWH)-OVERSCAN);
  var end=Math.min(total, Math.ceil((st+vh)/ROWH)+OVERSCAN);
  rowsEl.style.transform='translateY('+(start*ROWH)+'px)';
  var html='';
  for(var i=start;i<end;i++){
    var r=view[i];
    var sel=selected.has(r.id)?' sel':'';
    var chk=selected.has(r.id)?' checked':'';
    var thumbCell;
    if(r.thumb){
      thumbCell='<img class="rowthumb" src="'+r.thumb+'">';
    }else if(IMG_EXTS.indexOf(r.ext)>=0 || VID_EXTS.indexOf(r.ext)>=0){
      var vb=VID_EXTS.indexOf(r.ext)>=0?'<span class="vbadge">&#9658;</span>':'';
      thumbCell='<img class="rowthumb" loading="lazy" src="/api/thumb?id='+encodeURIComponent(r.id)+'&size=72" onerror="this.style.display=\'none\'">'+vb;
    }else{
      thumbCell='<div class="thumb-ph">'+esc((r.ext||'').replace('.','').slice(0,4)||'?')+'</div>';
    }
    html+='<div class="row'+sel+'" data-id="'+r.id+'">'
      +'<div class="c c-chk"><input type="checkbox" class="rchk"'+chk+'></div>'
      +'<div class="c c-thumb">'+thumbCell+'</div>'
      +'<div class="c c-name" title="'+esc(r.name)+'">'+esc(r.name)+'</div>'
      +'<div class="c c-size">'+humanSize(r.size)+'</div>'
      +'<div class="c c-date">'+fmtDate(r.mtimeMs)+'</div>'
      +'<div class="c c-cat">'+esc(r.category)+'</div>'
      +'<div class="c c-path" title="'+esc(r.path)+'">'+esc(r.path)+'</div>'
      +'</div>';
  }
  rowsEl.innerHTML=html;
}
viewport.addEventListener('scroll', renderList);
window.addEventListener('resize', renderList);

/**
 * 行のドラッグ一括選択。マウス押下した行を起点に、押下したままなぞった行を
 * まとめて選択/解除する（起点行の現在の選択状態を反転した値を全体へ適用）。
 * 仮想スクロールのため、なぞった範囲のうち実際に DOM 上へ描画されている行のみが対象になる。
 * @param {HTMLElement} containerEl 行を内包するコンテナ（イベント委任先）
 * @param {string} rowSelector 行要素の CSS セレクタ（例: '.row'）
 * @param {() => void} renderFn 選択状態変更後の再描画関数
 * @returns {{consumeMoved: () => boolean}} 直前の操作がドラッグだったかを取得・消費する
 */
function attachDragSelect(containerEl, rowSelector, renderFn){
  var dragValue=null, dragStartId=null, dragMoved=false;
  containerEl.addEventListener('mousedown', function(e){
    var row=e.target.closest(rowSelector);
    if(!row || !containerEl.contains(row)) return;
    if(e.button!==0) return;
    dragStartId=row.getAttribute('data-id');
    dragMoved=false;
    dragValue=!selected.has(dragStartId);
    document.body.style.userSelect='none';
  });
  document.addEventListener('mouseover', function(e){
    if(dragValue===null) return;
    var row=e.target.closest(rowSelector);
    if(!row || !containerEl.contains(row)) return;
    var id=row.getAttribute('data-id');
    if(id!==dragStartId) dragMoved=true;
    if(!dragMoved) return;
    if(dragValue){ selected.add(dragStartId); selected.add(id); }
    else{ selected.delete(dragStartId); selected.delete(id); }
    renderFn(); updateStatus();
  });
  document.addEventListener('mouseup', function(){
    if(dragValue!==null) document.body.style.userSelect='';
    dragValue=null;
  });
  return { consumeMoved: function(){ var m=dragMoved; dragMoved=false; return m; } };
}

/* 行クリック（選択・チェック・プレビュー） */
var rowsDrag=attachDragSelect(rowsEl, '.row', renderList);
rowsEl.addEventListener('click', function(e){
  if(rowsDrag.consumeMoved()) return; // ドラッグ選択直後のクリックは無視
  var row=e.target.closest('.row'); if(!row) return;
  var id=row.getAttribute('data-id');
  if(e.target.classList.contains('rchk')){
    toggleSel(id, e.target.checked);
  }else{
    showPreview(id);
  }
});
function toggleSel(id,on){
  if(on) selected.add(id); else selected.delete(id);
  renderList(); updateStatus();
}
$('chk-all').addEventListener('change', function(e){
  if(e.target.checked){ for(var i=0;i<view.length;i++) selected.add(view[i].id); }
  else selected.clear();
  renderList(); updateStatus();
});

/* ==== ソートヘッダ ==== */
Array.prototype.forEach.call(document.querySelectorAll('.listhead .c[data-sort]'), function(el){
  el.addEventListener('click', function(){
    var k=el.getAttribute('data-sort');
    if(sortKey===k) sortDir=-sortDir; else { sortKey=k; sortDir=(k==='size'||k==='mtimeMs')?-1:1; }
    rebuildView();
  });
});

/* ==== プレビュー ==== */
function showPreview(id){
  var r=byId[id]; if(!r) return;
  var info=[
    ['名前', r.name],['パス', r.path],['サイズ', humanSize(r.size)],
    ['カテゴリ', r.category],['更新', fmtDate(r.mtimeMs)],
    ['アクセス', fmtDate(r.atimeMs)],['作成', fmtDate(r.birthtimeMs)]
  ];
  var ih='';
  for(var i=0;i<info.length;i++){ ih+='<div><span class="k">'+info[i][0]+'</span><span class="v">'+esc(info[i][1])+'</span></div>'; }
  $('info').innerHTML=ih;

  var pv=$('preview');
  var imgExts=['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.tiff','.tif','.svg'];
  var txtExts=['.txt','.log','.json','.xml','.html','.htm','.css','.js','.ts','.md','.csv','.ini','.cfg','.conf','.yml','.yaml','.bat','.ps1','.sh','.py','.sql'];
  if(imgExts.indexOf(r.ext)>=0){
    // 取得できる最大サイズのシェルサムネイルを要求（本体は読まない＝OneDrive でもハイドレートなし）。
    // 表示は image-rendering:pixelated で最近傍拡大（モザイク状・非ぼかし）。
    pv.innerHTML='<img alt="preview" src="/api/thumb?id='+encodeURIComponent(id)+'&size=1024" onerror="this.parentNode.textContent=\'プレビューを取得できません\'">';
    var pimg=pv.querySelector('img');
    if(pimg && FULLQ_EXTS.indexOf(r.ext)>=0){
      pimg.style.cursor='zoom-in';
      pimg.title='クリックで原寸表示';
      pimg.addEventListener('click', function(){ openLightbox(id); });
    }
  }else if(VID_EXTS.indexOf(r.ext)>=0){
    // 動画: ポスター（サムネ）＋再生ボタン。クリックで <video> に差し替えて再生。
    pv.innerHTML='<div class="vidposter" title="クリックで再生"><img src="/api/thumb?id='+encodeURIComponent(id)+'&size=1024" onerror="this.style.display=\'none\'"><div class="playbtn">&#9658;</div></div>';
    var poster=pv.querySelector('.vidposter');
    if(poster){
      poster.addEventListener('click', function(){
        pv.innerHTML='<video src="/api/media?id='+encodeURIComponent(id)+'" controls autoplay playsinline></video>';
      });
    }
  }else if(txtExts.indexOf(r.ext)>=0){
    pv.textContent='読み込み中...';
    fetch('/api/preview?id='+encodeURIComponent(id)).then(function(res){return res.text();}).then(function(t){
      pv.innerHTML='<pre>'+esc(t)+'</pre>';
    }).catch(function(){ pv.textContent='プレビュー不可'; });
  }else{
    pv.textContent='バイナリファイル（プレビュー対象外）';
  }
}

/* ==== ステータス ==== */
function updateStatus(){
  var count=0, totalSize=0;
  if(mode==='duplicate'){
    for(var g=0;g<dupGroups.length;g++){ var fs=dupGroups[g].files; for(var k=0;k<fs.length;k++){ count++; totalSize+=fs[k].size; } }
  }else{
    count=records.length; for(var i=0;i<records.length;i++) totalSize+=records[i].size;
  }
  var selSize=0, selCount=0;
  selected.forEach(function(id){ var r=byId[id]; if(r){ selCount++; selSize+=r.size; } });
  $('st-count').textContent=count;
  $('st-size').textContent=humanSize(totalSize);
  $('st-sel').textContent=selCount;
  $('st-selsize').textContent=humanSize(selSize);
  $('btn-delete').disabled = selCount===0;
}
function setState(s,label){
  scanState=s;
  var sb=$('statusbar');
  sb.className='statusbar '+s;
  $('st-state').textContent=label;
  $('btn-scan').disabled=(s==='scanning'||s==='paused');
  $('btn-analyze').disabled=(s==='scanning'||s==='paused');
  $('btn-dup').disabled=(s==='scanning'||s==='paused');
  $('btn-pause').disabled=(s!=='scanning');
  $('btn-resume').disabled=(s!=='paused');
  $('btn-cancel').disabled=(s!=='scanning'&&s!=='paused');
}

/* ==== 重複ビュー ==== */
function setMode(m){
  mode=m;
  if(m==='duplicate') document.body.classList.add('dup-mode');
  else document.body.classList.remove('dup-mode');
}
function groupKeepId(group){
  // 最大サイズを保持（同点は新しい更新日時）。
  var keep=group.files[0];
  for(var i=1;i<group.files.length;i++){
    var f=group.files[i];
    if(f.size>keep.size || (f.size===keep.size && f.mtimeMs>keep.mtimeMs)) keep=f;
  }
  return keep.id;
}
function addDupGroup(kind, records){
  var group={kind:kind, files:records, keepId:null};
  group.keepId=groupKeepId(group);
  dupGroups.push(group);
  for(var i=0;i<records.length;i++){
    byId[records[i].id]=records[i];
    if(records[i].id!==group.keepId) selected.add(records[i].id); // 保持以外を既定で削除候補に
  }
  scheduleDupRender();
  updateStatus();
}
function scheduleDupRender(){
  if(dupRenderScheduled) return;
  dupRenderScheduled=true;
  requestAnimationFrame(function(){ dupRenderScheduled=false; renderDupGroups(); });
}
function renderDupGroups(){
  var imgExts=['.png','.jpg','.jpeg','.gif','.webp','.bmp','.ico','.tiff','.tif'];
  $('dup-empty').style.display = dupGroups.length?'none':'';
  var html='';
  for(var g=0;g<dupGroups.length;g++){
    var grp=dupGroups[g];
    // 解放可能サイズ = 保持以外の合計
    var reclaim=0, keepSize=0;
    for(var i=0;i<grp.files.length;i++){ if(grp.files[i].id===grp.keepId) keepSize=grp.files[i].size; else reclaim+=grp.files[i].size; }
    var badge = grp.kind==='exact' ? '<span class="badge exact">完全一致</span>' : '<span class="badge similar">類似画像</span>';
    html+='<div class="dgroup" data-g="'+g+'">';
    html+='<div class="dghead">'+badge+'<span>'+grp.files.length+' 件</span>'
      +'<span class="reclaim">解放可能 '+humanSize(reclaim)+'</span>'
      +'<button class="dg-auto" data-g="'+g+'">推奨選択に戻す</button></div>';
    for(var j=0;j<grp.files.length;j++){
      var f=grp.files[j];
      var isKeep=(f.id===grp.keepId);
      var chk=selected.has(f.id)?' checked':'';
      var thumb;
      if(f.thumb) thumb='<img class="dthumb" src="'+f.thumb+'">';
      else if(imgExts.indexOf(f.ext)>=0) thumb='<img class="dthumb" loading="lazy" src="/api/preview?id='+encodeURIComponent(f.id)+'">';
      else thumb='<div class="dthumb">'+esc(f.ext||'?')+'</div>';
      html+='<div class="dfile'+(isKeep?' keep':'')+'" data-id="'+f.id+'">'
        +'<input type="checkbox" class="dchk"'+chk+'>'
        +thumb
        +'<div class="dmeta"><div class="dname">'+esc(f.name)+'</div><div class="dpath" title="'+esc(f.path)+'">'+esc(f.path)+'</div></div>'
        +'<div class="dsize">'+humanSize(f.size)+'</div>'
        +'<span class="keep-badge">'+(isKeep?'保持':'')+'</span>'
        +'</div>';
    }
    html+='</div>';
  }
  $('dup-groups').innerHTML=html;
}
// 重複ビューのイベント委任
var dupDrag=attachDragSelect($('dup-groups'), '.dfile', renderDupGroups);
$('dup-groups').addEventListener('click', function(e){
  if(dupDrag.consumeMoved()) return; // ドラッグ選択直後のクリックは無視
  if(e.target.classList.contains('dchk')){
    var row=e.target.closest('.dfile'); if(!row) return;
    var id=row.getAttribute('data-id');
    if(e.target.checked) selected.add(id); else selected.delete(id);
    row.classList.toggle('picked', e.target.checked);
    updateStatus();
    return;
  }
  if(e.target.classList.contains('dg-auto')){
    var gi=parseInt(e.target.getAttribute('data-g'),10);
    var grp=dupGroups[gi]; if(!grp) return;
    for(var i=0;i<grp.files.length;i++){
      if(grp.files[i].id===grp.keepId) selected.delete(grp.files[i].id);
      else selected.add(grp.files[i].id);
    }
    renderDupGroups(); updateStatus();
    return;
  }
  // 行クリックでプレビュー
  var frow=e.target.closest('.dfile');
  if(frow) showPreview(frow.getAttribute('data-id'));
});

/* ==== SSE ==== */
var es=new EventSource('/api/events');
function resetResults(){
  records=[]; view=[]; byId=Object.create(null); selected.clear();
  dupGroups=[]; $('dup-groups').innerHTML=''; $('dup-empty').style.display='';
  $('chk-all').checked=false;
}
es.addEventListener('scanStarted', function(){
  setMode('junk'); resetResults();
  rebuildView();
  setState('scanning','スキャン中...');
});
es.addEventListener('fileFound', function(ev){
  var d=JSON.parse(ev.data);
  for(var i=0;i<d.records.length;i++){ var r=d.records[i]; records.push(r); byId[r.id]=r; }
  scheduleRebuild();
});
es.addEventListener('progress', function(ev){
  var d=JSON.parse(ev.data);
  if(d.phase){
    var labels={enumerate:'ファイル列挙',hash:'ハッシュ計算',phash:'画像解析',thumb:'サムネイル生成'};
    var t=(labels[d.phase]||d.phase)+': '+(d.scanCount!=null?d.scanCount:0);
    if(d.total) t+=' / '+d.total;
    $('progtext').textContent=t;
  }else{
    $('progtext').textContent=d.count+' 件検出中...';
  }
});
es.addEventListener('scanCompleted', function(ev){
  var d=JSON.parse(ev.data);
  setState('completed','完了'); $('progtext').textContent='完了: '+d.count+' 件';
  scheduleRebuild();
});
es.addEventListener('scanPaused', function(){ setState('paused','一時停止中'); });
es.addEventListener('scanResumed', function(){ setState('scanning', mode==='duplicate'?'重複検索中...':'スキャン中...'); });
es.addEventListener('scanCanceled', function(ev){
  var d=JSON.parse(ev.data);
  setState('idle','停止'); $('progtext').textContent='停止: '+d.count+' 件保持';
});
es.addEventListener('duplicatesStarted', function(){
  setMode('duplicate'); resetResults();
  setState('scanning','重複検索中...');
  $('progtext').textContent='列挙中...';
});
es.addEventListener('duplicateGroup', function(ev){
  var d=JSON.parse(ev.data);
  addDupGroup(d.kind, d.records);
});
es.addEventListener('duplicatesCompleted', function(ev){
  var d=JSON.parse(ev.data);
  setState('completed','完了');
  $('progtext').textContent='重複 '+d.groups+' グループ / '+d.files+' 件';
  renderDupGroups(); updateStatus();
});
es.addEventListener('deleteProgress', function(ev){
  var d=JSON.parse(ev.data);
  var pct = d.total>0 ? Math.round(d.done/d.total*100) : 100;
  $('del-bar').style.width=pct+'%';
  $('del-ptext').textContent='削除中... '+pct+'% ('+d.done+'/'+d.total+', '+humanSize(d.freed)+' 解放)';
});
es.addEventListener('error', function(ev){
  try{ var d=JSON.parse(ev.data); if(d&&d.message) $('progtext').textContent='エラー: '+d.message; }catch(e){}
});

/* ==== API 呼び出し ==== */
function api(path, body){
  return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},
    body: body?JSON.stringify(body):undefined}).then(function(r){return r.json();});
}
$('btn-scan').addEventListener('click', function(){
  var cats=selectedCategories();
  if(!cats.length){ alert('カテゴリを1つ以上選択してください'); return; }
  api('/api/scan/start',{categories:cats, filter:filterSpec});
});
$('btn-pause').addEventListener('click', function(){ api('/api/scan/pause'); });
$('btn-resume').addEventListener('click', function(){ api('/api/scan/resume'); });
$('btn-cancel').addEventListener('click', function(){ api('/api/scan/cancel'); });

/* ==== フォルダ解析（任意フォルダの通常スキャン） ==== */
$('btn-analyze').addEventListener('click', function(){ show('ov-analyze'); });
$('analyze-cancel-btn').addEventListener('click', function(){ hide('ov-analyze'); });
$('analyze-start').addEventListener('click', function(){
  var roots=$('analyze-roots').value.split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean);
  if(!roots.length){ alert('解析するフォルダを1つ以上入力してください'); return; }
  api('/api/scan/custom',{roots:roots, filter:filterSpec}).then(function(res){
    if(res && res.error){ alert(res.error); return; }
    hide('ov-analyze');
  });
});

/* ==== 重複検索 ==== */
$('btn-dup').addEventListener('click', function(){ show('ov-dup'); });
$('dup-cancel-btn').addEventListener('click', function(){ hide('ov-dup'); });
$('dup-threshold').addEventListener('input', function(e){
  var v=parseInt(e.target.value,10);
  var label = v<=4?'厳密':(v<=8?'標準':(v<=12?'緩め':'非常に緩い'));
  $('dup-threshold-val').textContent=v+' ('+label+')';
});
$('dup-start').addEventListener('click', function(){
  var roots=$('dup-roots').value.split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean);
  if(!roots.length){ alert('対象フォルダを1つ以上入力してください'); return; }
  var exact=$('dup-exact').checked, similar=$('dup-similar').checked;
  if(!exact && !similar){ alert('検出種別を1つ以上選択してください'); return; }
  api('/api/duplicates/start',{roots:roots, exact:exact, similar:similar, threshold:parseInt($('dup-threshold').value,10)}).then(function(res){
    if(res && res.error){ alert(res.error); return; }
    hide('ov-dup');
  });
});

/* ==== 削除 ==== */
/** 選択中アイテムの削除確認モーダルを開く（ボタン・右クリックメニュー共用）。 */
function openDeleteConfirm(){
  var selSize=0, n=0;
  selected.forEach(function(id){ var r=byId[id]; if(r){ n++; selSize+=r.size; } });
  if(!n) return;
  $('del-count').textContent=n;
  $('del-size').textContent=humanSize(selSize);
  // 設定の既定値をチェックボックスへ反映してから表示。
  $('del-permanent').checked = (deleteMode==='permanent');
  // 確認状態へリセット
  $('del-confirm').style.display='';
  $('del-progress').style.display='none';
  $('del-bar').style.width='0%';
  $('del-ok').disabled=false;
  show('ov-delete');
}
$('btn-delete').addEventListener('click', openDeleteConfirm);
$('del-cancel').addEventListener('click', function(){ hide('ov-delete'); });
$('del-ok').addEventListener('click', function(){
  var ids=Array.from(selected);
  if(!ids.length) return;
  var delMode = $('del-permanent').checked ? 'permanent' : 'trash';
  // 進捗表示へ切り替え
  $('del-confirm').style.display='none';
  $('del-progress').style.display='';
  $('del-bar').style.width='0%';
  $('del-ptext').textContent='削除中... 0%';
  api('/api/delete',{ids:ids, mode:delMode}).then(function(res){
    // 完了バー
    $('del-bar').style.width='100%';
    // 成功した id を除去
    var okSet=new Set();
    res.results.forEach(function(r){ if(r.ok) okSet.add(r.id); });
    okSet.forEach(function(id){ delete byId[id]; selected.delete(id); });
    if(mode==='duplicate'){
      // グループから削除済みを除去し、残り1件以下のグループは解消。
      var next=[];
      for(var g=0;g<dupGroups.length;g++){
        var grp=dupGroups[g];
        grp.files=grp.files.filter(function(f){ return !okSet.has(f.id); });
        if(grp.files.length>=2){
          if(!grp.files.some(function(f){return f.id===grp.keepId;})) grp.keepId=groupKeepId(grp);
          next.push(grp);
        }else{
          // 単独になったファイルは重複でないので選択解除して破棄。
          for(var i=0;i<grp.files.length;i++) selected.delete(grp.files[i].id);
        }
      }
      dupGroups=next;
      renderDupGroups(); updateStatus();
    }else{
      records=records.filter(function(r){ if(okSet.has(r.id)) return false; return true; });
      rebuildView();
    }
    $('progtext').textContent=res.deleted+' 件削除 ('+humanSize(res.freed)+' 解放)';
    $('del-ptext').textContent='完了: '+res.deleted+' 件削除 ('+humanSize(res.freed)+' 解放)';
    setTimeout(function(){ hide('ov-delete'); }, 600);
  }).catch(function(){
    $('del-ptext').textContent='削除中にエラーが発生しました';
    $('del-confirm').style.display='';
    $('del-progress').style.display='none';
  });
});

/* ==== 行の右クリックメニュー（一覧・重複ビュー共用） ==== */
var ctxMenu=$('ctx-menu');
function hideCtxMenu(){ ctxMenu.style.display='none'; }
/** 指定座標にメニューを開く。id が現在の選択に含まれなければ単独選択に切り替える。 */
function openCtxMenu(x, y, id, isDup){
  if(!selected.has(id)){
    selected.clear();
    selected.add(id);
    if(isDup){ renderDupGroups(); } else { renderList(); }
    updateStatus();
  }
  ctxMenu.style.display='block';
  var mw=ctxMenu.offsetWidth||140, mh=ctxMenu.offsetHeight||40;
  ctxMenu.style.left=Math.min(x, window.innerWidth-mw-4)+'px';
  ctxMenu.style.top=Math.min(y, window.innerHeight-mh-4)+'px';
}
rowsEl.addEventListener('contextmenu', function(e){
  var row=e.target.closest('.row'); if(!row) return;
  e.preventDefault();
  openCtxMenu(e.clientX, e.clientY, row.getAttribute('data-id'), false);
});
$('dup-groups').addEventListener('contextmenu', function(e){
  var row=e.target.closest('.dfile'); if(!row) return;
  e.preventDefault();
  openCtxMenu(e.clientX, e.clientY, row.getAttribute('data-id'), true);
});
$('ctx-delete').addEventListener('click', function(){
  hideCtxMenu();
  openDeleteConfirm();
});
document.addEventListener('click', function(e){
  if(ctxMenu.style.display==='block' && !ctxMenu.contains(e.target)) hideCtxMenu();
});
document.addEventListener('scroll', hideCtxMenu, true);
window.addEventListener('blur', hideCtxMenu);
document.addEventListener('keydown', function(e){ if(e.key==='Escape') hideCtxMenu(); });

/* ==== 検索条件モーダル ==== */
function collectFilter(){
  var f={};
  var name=$('f-name').value.trim(); if(name) f.nameContains=name;
  var ext=$('f-ext').value.trim(); if(ext) f.extensions=ext.split(',').map(function(s){return s.trim();}).filter(Boolean);
  var p=$('f-path').value.trim(); if(p) f.pathContains=p;
  var w=$('f-wild').value.trim(); if(w) f.wildcard=w;
  var rx=$('f-regex').value.trim(); if(rx) f.regex=rx;
  var smin=parseFloat($('f-smin').value); if(!isNaN(smin)) f.sizeMin=smin*1024*1024;
  var smax=parseFloat($('f-smax').value); if(!isNaN(smax)) f.sizeMax=smax*1024*1024;
  function dv(id){ var v=$(id).value; return v?new Date(v).getTime():null; }
  var m1=dv('f-mfrom'); if(m1!=null) f.mtimeFrom=m1;
  var m2=dv('f-mto'); if(m2!=null) f.mtimeTo=m2+86400000;
  var a1=dv('f-afrom'); if(a1!=null) f.atimeFrom=a1;
  var a2=dv('f-ato'); if(a2!=null) f.atimeTo=a2+86400000;
  var b1=dv('f-bfrom'); if(b1!=null) f.birthFrom=b1;
  var b2=dv('f-bto'); if(b2!=null) f.birthTo=b2+86400000;
  if($('f-hidden').checked) f.includeHidden=true;
  if($('f-system').checked) f.includeSystem=true;
  return f;
}
$('btn-search').addEventListener('click', function(){ show('ov-search'); });
$('s-close').addEventListener('click', function(){ filterSpec=collectFilter(); hide('ov-search'); });
$('s-reset').addEventListener('click', function(){
  ['f-name','f-ext','f-path','f-wild','f-regex','f-smin','f-smax','f-mfrom','f-mto','f-afrom','f-ato','f-bfrom','f-bto']
    .forEach(function(id){ $(id).value=''; });
  $('f-hidden').checked=false; $('f-system').checked=false;
  filterSpec={};
});

/* ==== 設定モーダル ==== */
$('btn-settings').addEventListener('click', function(){ show('ov-settings'); });
$('set-close').addEventListener('click', function(){ hide('ov-settings'); });
$('set-delmode').addEventListener('change', function(e){ deleteMode=e.target.value; });

/* ==== プリセット ==== */
var PRESETS=[];
$('preset').addEventListener('change', function(e){
  var id=e.target.value; if(!id) return;
  var p=null; for(var i=0;i<PRESETS.length;i++) if(PRESETS[i].id===id) p=PRESETS[i];
  if(!p) return;
  // カテゴリを設定
  Array.prototype.forEach.call(document.querySelectorAll('.catchk'), function(chk){
    chk.checked = p.categories.indexOf(chk.value)>=0;
  });
  // フィルタを設定（フォームへ反映）
  applyFilterToForm(p.filter||{});
  filterSpec = normalizeFilter(p.filter||{});
});
function normalizeFilter(f){
  var out={};
  for(var k in f) out[k]=f[k];
  return out;
}
function applyFilterToForm(f){
  $('f-ext').value = f.extensions? f.extensions.join(',') : '';
  $('f-name').value = f.nameContains||'';
  $('f-path').value = f.pathContains||'';
  $('f-smin').value = f.sizeMin? (f.sizeMin/1024/1024) : '';
  $('f-smax').value = f.sizeMax? (f.sizeMax/1024/1024) : '';
}

/* ==== モーダル制御 ==== */
function show(id){ $(id).classList.add('show'); }
function hide(id){ $(id).classList.remove('show'); }
Array.prototype.forEach.call(document.querySelectorAll('.overlay'), function(ov){
  ov.addEventListener('click', function(e){ if(e.target===ov) ov.classList.remove('show'); });
});

/* ==== 拡大プレビュー（原寸・高画質） ==== */
function openLightbox(id){
  $('lightbox-img').src='/api/media?id='+encodeURIComponent(id);
  show('ov-lightbox');
}
$('lightbox-img').addEventListener('click', function(){ hide('ov-lightbox'); });
document.addEventListener('keydown', function(e){
  if(e.key==='Escape') hide('ov-lightbox');
});

/* ==== パス入力補助（クイック選択・フォルダ選択で共用） ==== */
var USERDIRS=[];
var HOME='';
/** テキストエリアの内容を行配列にして返す（空行除去・トリム済み）。 */
function pathLinesOf(textareaId){
  return $(textareaId).value.split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean);
}
/** テキストエリアにパスを1行として追加（重複追加なし）。 */
function addPathTo(textareaId, p){
  var ta=$(textareaId);
  var lines=pathLinesOf(textareaId);
  if(lines.indexOf(p)<0) lines.push(p);
  ta.value=lines.join('\n');
}
/** テキストエリアから該当パスの行を削除する。 */
function removePathFrom(textareaId, p){
  var ta=$(textareaId);
  var lines=pathLinesOf(textareaId).filter(function(s){return s!==p;});
  ta.value=lines.join('\n');
}
function renderQuickInto(containerId, dirs){
  var q=$(containerId);
  if(!dirs || !dirs.length){ q.innerHTML=''; return; }
  var h='<span class="qlabel">クイック選択:</span>';
  for(var i=0;i<dirs.length;i++){
    h+='<button type="button" class="chip" data-path="'+esc(dirs[i].path)+'" title="'+esc(dirs[i].path)+'">'+esc(dirs[i].name)+'</button>';
  }
  q.innerHTML=h;
}
/** クイック選択チップの選択状態（active）をテキストエリアの内容に合わせて更新する。 */
function syncQuickChips(containerId, textareaId){
  var lines=pathLinesOf(textareaId);
  var chips=$(containerId).querySelectorAll('.chip');
  for(var i=0;i<chips.length;i++){
    var p=chips[i].getAttribute('data-path');
    chips[i].classList.toggle('active', lines.indexOf(p)>=0);
  }
}
function wireQuick(containerId, textareaId){
  $(containerId).addEventListener('click', function(e){
    var p=e.target.getAttribute('data-path');
    if(!p) return;
    if(pathLinesOf(textareaId).indexOf(p)>=0) removePathFrom(textareaId, p);
    else addPathTo(textareaId, p);
    syncQuickChips(containerId, textareaId);
  });
  $(textareaId).addEventListener('input', function(){ syncQuickChips(containerId, textareaId); });
}
wireQuick('dup-quick','dup-roots');
wireQuick('analyze-quick','analyze-roots');
var QUICK_MAP={'dup-roots':'dup-quick','analyze-roots':'analyze-quick'};

/* ==== フォルダ選択ダイアログ（サーバー側ディレクトリブラウザ） ==== */
var browseTarget='';      // 選択結果を入れるテキストエリア id
var browseCurrent='';     // 現在表示中のパス
var browseParent='';      // 親パス
function openBrowse(targetTextareaId){
  browseTarget=targetTextareaId;
  show('ov-browse');
  loadBrowse(HOME||'');
}
function loadBrowse(p){
  fetch('/api/browse?path='+encodeURIComponent(p||'')).then(function(r){return r.json();}).then(function(d){
    browseCurrent=d.path||'';
    browseParent=d.parent||'';
    $('browse-path').textContent = browseCurrent || 'PC（ドライブ選択）';
    $('browse-up').disabled = !browseCurrent; // ドライブ一覧では「上へ」無効
    $('browse-pick').disabled = !browseCurrent; // ドライブ一覧のルートは選択不可
    var list=$('browse-list');
    if(d.error){ list.innerHTML='<div class="browse-empty">'+esc(d.error)+'</div>'; return; }
    if(!d.entries.length){ list.innerHTML='<div class="browse-empty">サブフォルダはありません</div>'; return; }
    var h='';
    for(var i=0;i<d.entries.length;i++){
      var e=d.entries[i];
      h+='<div class="browse-item" data-path="'+esc(e.path)+'"><span class="ico">&#128193;</span><span>'+esc(e.name)+'</span></div>';
    }
    list.innerHTML=h;
  }).catch(function(){ $('browse-list').innerHTML='<div class="browse-empty">読み込みに失敗しました</div>'; });
}
$('browse-list').addEventListener('click', function(e){
  var row=e.target.closest('.browse-item'); if(!row) return;
  loadBrowse(row.getAttribute('data-path'));
});
$('browse-up').addEventListener('click', function(){ loadBrowse(browseParent); });
$('browse-cancel').addEventListener('click', function(){ hide('ov-browse'); });
$('browse-pick').addEventListener('click', function(){
  if(browseCurrent && browseTarget){
    addPathTo(browseTarget, browseCurrent);
    var qid=QUICK_MAP[browseTarget];
    if(qid) syncQuickChips(qid, browseTarget);
  }
  hide('ov-browse');
});
$('analyze-browse').addEventListener('click', function(){ openBrowse('analyze-roots'); });
$('dup-browse').addEventListener('click', function(){ openBrowse('dup-roots'); });

(function(){
  var resizer=$('resizer'), rightPanel=$('right-panel');
  var mainEl=document.querySelector('.main');
  var minW=220, maxW=700;
  var saved=parseInt(localStorage.getItem('previewWidth')||'',10);
  if(saved>=minW && saved<=maxW) rightPanel.style.width=saved+'px';
  var dragging=false;
  resizer.addEventListener('mousedown', function(e){
    dragging=true;
    resizer.classList.add('dragging');
    document.body.style.userSelect='none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function(e){
    if(!dragging) return;
    var w=mainEl.getBoundingClientRect().right-e.clientX;
    if(w<minW) w=minW;
    if(w>maxW) w=maxW;
    rightPanel.style.width=w+'px';
  });
  document.addEventListener('mouseup', function(){
    if(!dragging) return;
    dragging=false;
    resizer.classList.remove('dragging');
    document.body.style.userSelect='';
    localStorage.setItem('previewWidth', parseInt(rightPanel.style.width,10));
  });
})();

/* ==== 列幅リサイズ ==== */
(function(){
  var COLS=['size','date','cat','path'];
  var minW=40, maxW=600;
  var root=document.documentElement;
  var saved={};
  try{ saved=JSON.parse(localStorage.getItem('colWidths')||'{}'); }catch(e){}
  for(var i=0;i<COLS.length;i++){
    var c=COLS[i], w=parseInt(saved[c],10);
    if(w>=minW && w<=maxW) root.style.setProperty('--col-'+c, w+'px');
  }
  var dragging=null, startX=0, startW=0;
  Array.prototype.forEach.call(document.querySelectorAll('.col-resize-handle'), function(handle){
    handle.addEventListener('click', function(e){ e.stopPropagation(); });
    handle.addEventListener('mousedown', function(e){
      e.stopPropagation(); e.preventDefault();
      dragging=handle.getAttribute('data-col');
      startX=e.clientX;
      var cell=handle.parentElement;
      startW=cell.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.style.userSelect='none';
    });
  });
  document.addEventListener('mousemove', function(e){
    if(!dragging) return;
    var w=startW+(e.clientX-startX);
    if(w<minW) w=minW;
    if(w>maxW) w=maxW;
    root.style.setProperty('--col-'+dragging, w+'px');
  });
  document.addEventListener('mouseup', function(){
    if(!dragging) return;
    var handle=document.querySelector('.col-resize-handle[data-col="'+dragging+'"]');
    if(handle) handle.classList.remove('dragging');
    document.body.style.userSelect='';
    var cur={};
    for(var i=0;i<COLS.length;i++){
      var v=getComputedStyle(root).getPropertyValue('--col-'+COLS[i]);
      if(v) cur[COLS[i]]=parseInt(v,10);
    }
    localStorage.setItem('colWidths', JSON.stringify(cur));
    dragging=null;
  });
})();

/* ==== 初期化 ==== */
fetch('/api/presets').then(function(r){return r.json();}).then(function(d){
  CATEGORIES=d.categories; renderCats();
  PRESETS=d.presets;
  var sel=$('preset');
  for(var i=0;i<PRESETS.length;i++){
    var o=document.createElement('option'); o.value=PRESETS[i].id; o.textContent=PRESETS[i].name; sel.appendChild(o);
  }
  USERDIRS=d.userDirs||[];
  HOME=d.home||'';
  renderQuickInto('dup-quick', USERDIRS);
  renderQuickInto('analyze-quick', USERDIRS);
  syncQuickChips('dup-quick', 'dup-roots');
  syncQuickChips('analyze-quick', 'analyze-roots');
});
setState('idle','待機中');
