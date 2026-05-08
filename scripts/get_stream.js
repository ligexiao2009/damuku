javascript:(function(){
  var urls=[];
  try{
    var r=performance.getEntriesByType('resource');
    for(var i=0;i<r.length;i++){
      var u=r[i].name;
      if(/\.m3u8|\.mpd|\.ts|flv\?|live\.|pull\.|stream\./i.test(u)){
        urls.push(u);
      }
    }
  }catch(e){}
  if(!urls.length){alert('未找到流地址，请刷新页面后再试');return;}
  var t='流地址 ('+urls.length+'):\n\n'+urls.join('\n\n');
  var w=window.open('','_blank','width=700,height=400');
  w.document.write('<pre style=white-space:pre-wrap;word-break:break-all;font-size:13px>'+t.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</pre>');
  navigator.clipboard.writeText(urls[0]).then(function(){w.document.body.insertBefore(document.createTextNode('\n\n(第一条已复制到剪贴板)'),w.document.body.firstChild)});
})();
