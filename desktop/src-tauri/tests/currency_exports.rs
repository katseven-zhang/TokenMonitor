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
    let q=Query{start:60_000,end:120_000,agent:Some("codex".into()),model:None,project:None,session:None,search:String::new(),offset_minutes:0};
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
