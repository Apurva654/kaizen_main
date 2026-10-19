import sys
import json
from pathlib import Path
from graphify.detect import detect
from graphify.extract import extract
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all, label_communities_by_hub
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json, to_html

def main():
    target_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src")
    out_dir = Path("graphify-out")
    out_dir.mkdir(exist_ok=True)
    
    print(f"1. Detecting codebase files in {target_root}...")
    det = detect(target_root)
    code_paths = [Path(p) for p in det["files"].get("code", [])]
    doc_paths = [Path(p) for p in det["files"].get("document", [])]
    all_paths = code_paths + doc_paths
    print(f"   Found {len(all_paths)} files ({len(code_paths)} code, {len(doc_paths)} docs).")
    
    print("2. Extracting AST symbols, functions, classes, and dependency edges...")
    ast = extract(all_paths)
    print(f"   Extracted {len(ast['nodes'])} nodes and {len(ast['edges'])} edges.")
    
    merged = {
        "nodes": ast["nodes"],
        "edges": ast["edges"],
        "hyperedges": [],
        "input_tokens": 0,
        "output_tokens": 0
    }
    
    print("3. Building directed knowledge graph with community clustering...")
    G = build_from_json(merged, root=str(target_root), directed=True)
    print(f"   Graph nodes: {G.number_of_nodes()}, edges: {G.number_of_edges()}")
    
    communities = cluster(G)
    cohesion = score_all(G, communities)
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    
    # 4. Generate intelligent community labels from hub nodes
    labels = label_communities_by_hub(G, communities)
    questions = suggest_questions(G, communities, labels)
    
    print("4. Exporting GraphRAG JSON, HTML visualizer, and markdown report...")
    # Force overwrite and include community labels in graph.json
    to_json(G, communities, str(out_dir / "graph.json"), force=True, community_labels=labels)
    
    # Generate interactive browser visualization
    to_html(G, communities, str(out_dir / "graph.html"), community_labels=labels)
    
    # Generate human-readable markdown report
    report = generate(
        G, communities, cohesion, labels, gods, surprises, det,
        {"input": 0, "output": 0}, str(target_root), suggested_questions=questions
    )
    (out_dir / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
    
    # Export analysis and label metadata for CLI query and reflect tools
    analysis = {
        "communities": {str(k): v for k, v in communities.items()},
        "cohesion": {str(k): v for k, v in cohesion.items()},
        "gods": gods,
        "surprises": surprises,
        "questions": questions
    }
    (out_dir / ".graphify_analysis.json").write_text(json.dumps(analysis, indent=2, ensure_ascii=False), encoding="utf-8")
    (out_dir / ".graphify_labels.json").write_text(json.dumps({str(k): v for k, v in labels.items()}, indent=2, ensure_ascii=False), encoding="utf-8")
    
    print(f"Done! Saved graph to:")
    print(f"  - {out_dir / 'graph.json'}")
    print(f"  - {out_dir / 'graph.html'}")
    print(f"  - {out_dir / 'GRAPH_REPORT.md'}")

if __name__ == "__main__":
    main()
