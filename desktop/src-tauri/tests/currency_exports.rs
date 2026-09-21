use serde_json::json;
use std::fs;
use tokenmonitor_core::{config,db,model::{Event,Parsed,Query,Tokens},service};

#[test]
fn mixed_native_prices_export_in_selected_currency_without_changing_tokens() {
    let root=std::env::temp_dir().join(format!("tm-currency-{}",uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();
    let mut cache=db::open(&root).unwrap();
    let events=["domestic","foreign"].into_iter().map(|model|Event{id:model.into(),model:model.into(),agent:"codex".into(),session:"s".into(),project:"p".into(),path:"fixture".into(),line:1,ts:60_000,tokens:Tokens{input:1_000_000,output:1_000_000,..Default::default()}}).collect();
    db::replace_file(&mut cache,"fixture","codex",1,1,&Parsed{events,..Default::default()}).unwrap();
    let q=Query{start:60_000,end:120_000,agent:Some("codex".into()),model:None,project:None,session:None,search:String::new(),time_zone: None, offset_minutes: 0};
    for (currency,expected) in [("CNY","28.00000000"),("USD","4.00000000")] {
        let prices=json!({"version":1,"currency":"USD","displayCurrency":currency,"usdCny":7,"models":{"domestic":[{"currency":"cny","input":7,"cached":0,"cacheWrite":0,"output":21}],"foreign":[{"input":1,"cached":0,"cacheWrite":0,"output":3}]}});
        fs::write(root.join("prices.json"),prices.to_string()).unwrap();
        let data=service::query_local(&root,"dashboard",&json!({"query":q})).unwrap();
        assert_eq!(data["totals"]["knownCostUsd"],8.0);
        assert_eq!(data["totals"]["totalTokens"],4_000_000);
        for format in ["csv","markdown"] {
            let path=root.join(format!("export.{format}"));
            let result=service::query_local(&root,"export",&json!({"query":q,"format":format,"path":path})).unwrap();
            assert_eq!(result["rows"],2);
            let text=fs::read_to_string(path).unwrap();
            assert!(text.contains(&format!("Estimated {currency}")));
            assert_eq!(text.matches(expected).count(),2);
        }
        // Saving/display conversion does not rewrite either model's native price.
        let unchanged:serde_json::Value=serde_json::from_str(&fs::read_to_string(root.join("prices.json")).unwrap()).unwrap();
        assert_eq!(unchanged,prices);
    }
    drop(cache);fs::remove_dir_all(root).unwrap();
}

/// #62：导出不再携带 `\\?\` verbatim 前缀。存储键本身不改（旧库行同格式），
/// 所以断言以“落库路径带前缀、导出单元格里没有前缀”为准；xlsx 的对应断言
/// 在 #82 的解包级校验里。合成盘符 Q: 是纯数据，不触碰文件系统。
#[test]
fn verbatim_source_paths_leave_the_export_text_formats() {
    let root=std::env::temp_dir().join(format!("tm-verbatim-{}",uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();
    let mut cache=db::open(&root).unwrap();
    let stored=format!("\\\\?\\{}","Q:\\sessions\\a.jsonl");
    let event=Event{id:"1".into(),model:"m".into(),agent:"codex".into(),session:"s".into(),project:"p".into(),path:stored.clone(),line:7,ts:60_000,tokens:Tokens{input:1,output:0,..Default::default()}};
    db::replace_file(&mut cache,&stored,"codex",1,1,&Parsed{events:vec![event],..Default::default()}).unwrap();
    let q=Query{start:60_000,end:120_000,agent:Some("codex".into()),model:None,project:None,session:None,search:String::new(),time_zone:None,offset_minutes:0};
    for format in ["csv","markdown"] {
        let path=root.join(format!("verbatim.{format}"));
        service::query_local(&root,"export",&json!({"query":q,"format":format,"path":path})).unwrap();
        let text=fs::read_to_string(&path).unwrap();
        assert!(text.contains(r"Q:\sessions\a.jsonl"),"{format}: 导出缺少还原后的路径");
        assert!(!text.contains(r"\\?\"),"{format}: 导出仍带 verbatim 前缀");
    }
    // 存储键没被动过：reveal 的授权查询仍以原样路径命中。
    let hits: i64 = cache.query_row("SELECT COUNT(*) FROM source_files WHERE path=?1", [&stored], |r|r.get(0)).unwrap();
    assert_eq!(hits,1);
    drop(cache);fs::remove_dir_all(root).unwrap();
}

/// #82：xlsx 导出此前只被断言过 ZIP 魔数（任何 zip 都能过），等于没有校验。
/// 现在解包看真实内容：必备部件齐全、表头在、成本与 token 是数字单元格里
/// 的黄金数（1M input × 2/百万 = 2.0），#62 的还原也随 xlsx 落进 sheet。
#[test]
fn xlsx_export_content_is_checked_beyond_zip_magic() {
    let root=std::env::temp_dir().join(format!("tm-xlsx-{}",uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();
    let mut cache=db::open(&root).unwrap();
    let event=Event{id:"1".into(),model:"priced".into(),agent:"codex".into(),session:"s".into(),project:"p".into(),path:r"\\?\Q:\sessions\a.jsonl".to_string(),line:7,ts:60_000,tokens:Tokens{input:1_000_000,output:0,..Default::default()}};
    db::replace_file(&mut cache,"f","codex",1,1,&Parsed{events:vec![event],..Default::default()}).unwrap();
    fs::write(root.join("prices.json"),json!({"version":1,"currency":"USD","models":{"priced":[{"input":2,"cached":0,"cacheWrite":0,"output":0}]}}).to_string()).unwrap();
    let q=Query{start:60_000,end:120_000,agent:Some("codex".into()),model:None,project:None,session:None,search:String::new(),time_zone:None,offset_minutes:0};
    let path=root.join("deep.xlsx");
    service::query_local(&root,"export",&json!({"query":q,"format":"xlsx","path":path})).unwrap();
    let mut archive=zip::ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
    let mut names=Vec::new();
    let mut sheet=String::new();
    let mut shared=String::new();
    for i in 0..archive.len() {
        let mut entry=archive.by_index(i).unwrap();
        names.push(entry.name().to_string());
        if entry.name()=="xl/worksheets/sheet1.xml" {
            std::io::Read::read_to_string(&mut entry,&mut sheet).unwrap();
        }
        if entry.name()=="xl/sharedStrings.xml" {
            std::io::Read::read_to_string(&mut entry,&mut shared).unwrap();
        }
    }
    for part in ["[Content_Types].xml","xl/workbook.xml","xl/worksheets/sheet1.xml","xl/sharedStrings.xml"] {
        assert!(names.iter().any(|n|n==part),"{part} 缺失：{names:?}");
    }
    assert!(shared.contains(">Source<")&&shared.contains(">Estimated USD<")&&shared.contains(">Line<"),"{shared}");
    assert!(sheet.contains(r#"<c r="F2"><v>1000000</v></c>"#),"Input 黄金数没进 F2 数字单元格：{sheet}");
    assert!(sheet.contains(r#"<c r="L2"><v>2</v></c>"#),"成本 1M×2/百万=2.0 没进 L2 数字单元格：{sheet}");
    assert!(shared.contains(r"Q:\sessions\a.jsonl")&&!shared.contains(r"\\?\"),"#62 的 verbatim 还原没进 xlsx：{shared}");
    // #83 现状记录：Line 列此刻仍是文本单元格（Excel 会给它挂"以文本形式存储的
    // 数字"警告）。#83 把它改成数字单元格时，这条断言随之翻转。
    assert!(shared.contains("<si><t>7</t></si>"),"Line=7 当前以共享字符串落盘：{shared}");
    drop(cache);fs::remove_dir_all(root).unwrap();
}
