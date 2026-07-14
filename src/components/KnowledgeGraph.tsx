import { useState, useEffect, useRef, MouseEvent } from 'react';
import { Entity, Relation, EntityType } from '../types';
import { Maximize2, Minimize2, ZoomIn, ZoomOut, RefreshCw, Info, Download } from 'lucide-react';

interface KnowledgeGraphProps {
  entities: Entity[];
  relations: Relation[];
  selectedEntityId?: string | null;
  onSelectEntity: (id: string | null) => void;
}

interface GraphNode {
  id: string;
  name: string;
  type: EntityType;
  description?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GraphLink {
  id: string;
  source: string;
  target: string;
  type: string;
}

export default function KnowledgeGraph({
  entities,
  relations,
  selectedEntityId,
  onSelectEntity
}: KnowledgeGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  
  const simulationRef = useRef<number | null>(null);

  // Initialize nodes and links
  useEffect(() => {
    if (entities.length === 0) {
      setNodes([]);
      setLinks([]);
      return;
    }

    const width = containerRef.current?.clientWidth || 600;
    const height = containerRef.current?.clientHeight || 400;

    // Arrange nodes in a beautiful circle/star layout initially
    const newNodes: GraphNode[] = entities.map((entity, index) => {
      // Find existing coordinates to keep continuity if possible
      const existing = nodes.find(n => n.id === entity.id);
      if (existing) {
        return { ...existing, name: entity.name, type: entity.type, description: entity.description };
      }

    // Position Patient at the center, Doctor slightly to the side, others in a circle
      let x = width / 2;
      let y = height / 2;

      if (entity.type === 'Patient' || (entity.type === 'Person' && (entity.name.toLowerCase().includes('patient') || entity.name.toLowerCase().includes('subject')))) {
        x = width / 2;
        y = height / 2;
      } else if (entity.type === 'Doctor' || (entity.type === 'Person' && (entity.name.toLowerCase().includes('doctor') || entity.name.toLowerCase().includes('dr.')))) {
        x = width / 2 - 160;
        y = height / 2 - 80;
      } else if (entity.type === 'Person') {
        const angle = (index / (entities.length || 1)) * 2 * Math.PI;
        x = width / 2 + Math.cos(angle) * 120;
        y = height / 2 + Math.sin(angle) * 120;
      } else {
        const angle = (index / (entities.length || 1)) * 2 * Math.PI;
        const radius = 200 + Math.random() * 60;
        x = width / 2 + Math.cos(angle) * radius;
        y = height / 2 + Math.sin(angle) * radius;
      }

      return {
        id: entity.id,
        name: entity.name,
        type: entity.type,
        description: entity.description,
        x,
        y,
        vx: 0,
        vy: 0
      };
    });

    const newLinks: GraphLink[] = relations.map(rel => ({
      id: rel.id,
      source: rel.source,
      target: rel.target,
      type: rel.type
    }));

    setNodes(newNodes);
    setLinks(newLinks);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [entities, relations]);

  // Force-directed layout simulation
  useEffect(() => {
    if (nodes.length === 0) return;

    const width = containerRef.current?.clientWidth || 600;
    const height = containerRef.current?.clientHeight || 400;

    const runSimulation = () => {
      setNodes(prevNodes => {
        if (prevNodes.length === 0) return prevNodes;

        // Clone nodes to update positions
        const updatedNodes = prevNodes.map(node => ({ ...node }));

        // 1. Repulsion force between all node pairs
        for (let i = 0; i < updatedNodes.length; i++) {
          const nodeA = updatedNodes[i];
          for (let j = i + 1; j < updatedNodes.length; j++) {
            const nodeB = updatedNodes[j];
            const dx = nodeB.x - nodeA.x;
            const dy = nodeB.y - nodeA.y;
            const distance = Math.sqrt(dx * dx + dy * dy) || 1;

            const isSpeakerInvolved = 
              nodeA.type === 'Patient' || nodeA.type === 'Doctor' || nodeA.type === 'Person' || 
              nodeB.type === 'Patient' || nodeB.type === 'Doctor' || nodeB.type === 'Person';
            
            const repulsionRadius = isSpeakerInvolved ? 380 : 280;
            const forceConstant = isSpeakerInvolved ? 220 : 160;

            if (distance < repulsionRadius) {
              // Repulsion force formula
              const force = (forceConstant * forceConstant) / (distance * distance);
              const fx = (dx / distance) * force * 0.22;
              const fy = (dy / distance) * force * 0.22;

              // Do not apply full force to dragged node
              if (nodeA.id !== draggedNodeId) {
                nodeA.vx -= fx;
                nodeA.vy -= fy;
              }
              if (nodeB.id !== draggedNodeId) {
                nodeB.vx += fx;
                nodeB.vy += fy;
              }
            }
          }
        }

        // 2. Attraction force along links
        links.forEach(link => {
          const sourceNode = updatedNodes.find(n => n.id === link.source);
          const targetNode = updatedNodes.find(n => n.id === link.target);

          if (sourceNode && targetNode) {
            const dx = targetNode.x - sourceNode.x;
            const dy = targetNode.y - sourceNode.y;
            const distance = Math.sqrt(dx * dx + dy * dy) || 1;

            // Desired link length - make speaker-linked edges much longer to spread out concepts
            const isSpeakerInvolved = 
              sourceNode.type === 'Patient' || sourceNode.type === 'Doctor' || sourceNode.type === 'Person' || 
              targetNode.type === 'Patient' || targetNode.type === 'Doctor' || targetNode.type === 'Person';
            const desiredLength = isSpeakerInvolved ? 220 : 150;
            const k = 0.04; // Spring constant
            const force = k * (distance - desiredLength);

            const fx = (dx / distance) * force;
            const fy = (dy / distance) * force;

            if (sourceNode.id !== draggedNodeId) {
              sourceNode.vx += fx;
              sourceNode.vy += fy;
            }
            if (targetNode.id !== draggedNodeId) {
              targetNode.vx -= fx;
              targetNode.vy -= fy;
            }
          }
        });

        // 3. Gravity center force & boundary safety
        const cx = width / 2;
        const cy = height / 2;
        const gravity = 0.006; // reduced from 0.012 to let nodes spread out further

        updatedNodes.forEach(node => {
          if (node.id === draggedNodeId) return;

          // Pull to center
          node.vx += (cx - node.x) * gravity;
          node.vy += (cy - node.y) * gravity;

          // Apply velocity and damping
          node.x += node.vx;
          node.y += node.vy;
          node.vx *= 0.82; // damping
          node.vy *= 0.82; // damping

          // Keep within container limits
          const margin = 40;
          if (node.x < margin) { node.x = margin; node.vx = 0; }
          if (node.x > width - margin) { node.x = width - margin; node.vx = 0; }
          if (node.y < margin) { node.y = margin; node.vy = 0; }
          if (node.y > height - margin) { node.y = height - margin; node.vy = 0; }
        });

        return updatedNodes;
      });

      simulationRef.current = requestAnimationFrame(runSimulation);
    };

    simulationRef.current = requestAnimationFrame(runSimulation);

    return () => {
      if (simulationRef.current) {
        cancelAnimationFrame(simulationRef.current);
      }
    };
  }, [links, draggedNodeId]);

  // Handle Dragging
  const handleMouseDown = (nodeId: string, event: MouseEvent) => {
    event.stopPropagation();
    setDraggedNodeId(nodeId);
    onSelectEntity(nodeId);
  };

  const handleMouseMove = (event: MouseEvent) => {
    if (draggedNodeId && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      // Adjust for pan and zoom
      const mouseX = (event.clientX - rect.left - pan.x) / zoom;
      const mouseY = (event.clientY - rect.top - pan.y) / zoom;

      setNodes(prev =>
        prev.map(n => (n.id === draggedNodeId ? { ...n, x: mouseX, y: mouseY, vx: 0, vy: 0 } : n))
      );
    } else if (isPanning) {
      const dx = event.clientX - panStart.x;
      const dy = event.clientY - panStart.y;
      setPan({ x: pan.x + dx, y: pan.y + dy });
      setPanStart({ x: event.clientX, y: event.clientY });
    }
  };

  const handleMouseUp = () => {
    setDraggedNodeId(null);
    setIsPanning(false);
  };

  const handleContainerMouseDown = (event: MouseEvent) => {
    if (event.target === containerRef.current || (event.target as HTMLElement).tagName === 'svg') {
      setIsPanning(true);
      setPanStart({ x: event.clientX, y: event.clientY });
    }
  };

  const resetLayout = () => {
    if (containerRef.current) {
      const width = containerRef.current.clientWidth || 600;
      const height = containerRef.current.clientHeight || 400;
      setNodes(prev =>
        prev.map((n, idx) => {
          const angle = (idx / (prev.length || 1)) * 2 * Math.PI;
          let radius = 220;
          if (n.type === 'Patient' || (n.type === 'Person' && (n.name.toLowerCase().includes('patient') || n.name.toLowerCase().includes('subject')))) {
            radius = 0;
          } else if (n.type === 'Doctor' || (n.type === 'Person' && (n.name.toLowerCase().includes('doctor') || n.name.toLowerCase().includes('dr.')))) {
            radius = 120;
          } else if (n.type === 'Person') {
            radius = 160;
          }
          return {
            ...n,
            x: width / 2 + Math.cos(angle) * radius,
            y: height / 2 + Math.sin(angle) * radius,
            vx: 0,
            vy: 0
          };
        })
      );
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  };

  const exportGraphJson = () => {
    const exportData = {
      entities: entities.map(e => ({
        id: e.id,
        name: e.name,
        type: e.type,
        description: e.description,
        textSpan: e.textSpan
      })),
      relations: relations.map(r => ({
        id: r.id,
        source: r.source,
        target: r.target,
        type: r.type
      }))
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `clinical_knowledge_graph_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // Node Color Mapper
  const getNodeColor = (type: EntityType) => {
    switch (type) {
      case 'Person':
        return {
          bg: '#f5f3ff', // violet-50
          border: '#7c3aed', // violet-600
          text: '#4c1d95', // violet-950
          shadow: 'rgba(124, 58, 237, 0.2)'
        };
      case 'Patient':
        return {
          bg: '#eef2ff', // indigo-50
          border: '#4f46e5', // indigo-600
          text: '#312e81', // indigo-950
          shadow: 'rgba(79, 70, 229, 0.2)'
        };
      case 'Doctor':
        return {
          bg: '#f8fafc', // slate-50
          border: '#64748b', // slate-500
          text: '#0f172a', // slate-900
          shadow: 'rgba(100, 116, 139, 0.15)'
        };
      case 'Symptom':
        return {
          bg: '#fffbeb', // amber-50
          border: '#d97706', // amber-600
          text: '#78350f', // amber-950
          shadow: 'rgba(217, 119, 6, 0.2)'
        };
      case 'Condition':
        return {
          bg: '#fff7ed', // orange-50
          border: '#ea580c', // orange-600
          text: '#7c2d12', // orange-950
          shadow: 'rgba(234, 88, 12, 0.2)'
        };
      case 'Medication':
        return {
          bg: '#eff6ff', // blue-50
          border: '#2563eb', // blue-600
          text: '#1e3a8a', // blue-950
          shadow: 'rgba(37, 99, 235, 0.2)'
        };
      case 'Dosage':
        return {
          bg: '#f0fdfa', // teal-50
          border: '#0d9488', // teal-600
          text: '#115e59', // teal-950
          shadow: 'rgba(13, 148, 136, 0.2)'
        };
      case 'FollowUp':
        return {
          bg: '#f0fdf4', // green-50
          border: '#16a34a', // green-600
          text: '#14532d', // green-950
          shadow: 'rgba(22, 163, 74, 0.2)'
        };
      default:
        return {
          bg: '#f8fafc', // slate-50
          border: '#94a3b8', // slate-400
          text: '#334155', // slate-700
          shadow: 'rgba(148, 163, 184, 0.15)'
        };
    }
  };

  const getConnectedNodeIds = (nodeId: string) => {
    const connected = new Set<string>();
    connected.add(nodeId);
    links.forEach(link => {
      if (link.source === nodeId) connected.add(link.target);
      if (link.target === nodeId) connected.add(link.source);
    });
    return connected;
  };

  const highlightedNodeIds = hoveredNodeId ? getConnectedNodeIds(hoveredNodeId) : null;
  const activeSelectedNode = nodes.find(n => n.id === selectedEntityId);
  const activeSelectedEntity = entities.find(e => e.id === selectedEntityId);

  return (
    <div 
      className={`relative border border-slate-200 bg-slate-50/50 rounded-xl flex flex-col transition-all duration-300 ${
        isFullscreen ? 'fixed inset-4 z-50 bg-white shadow-2xl' : 'h-[calc(100vh-200px)] max-h-[calc(100vh-8rem)] min-h-[400px] w-full'
      }`}
    >
      {/* Graph Toolbar */}
      <div className="absolute top-4 left-4 z-10 flex gap-2">
        <button
          onClick={() => setZoom(prev => Math.min(prev + 0.15, 3))}
          className="p-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 hover:text-slate-900 rounded-lg shadow-sm transition-colors cursor-pointer"
          title="Zoom In"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={() => setZoom(prev => Math.max(prev - 0.15, 0.5))}
          className="p-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 hover:text-slate-900 rounded-lg shadow-sm transition-colors cursor-pointer"
          title="Zoom Out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          onClick={resetLayout}
          className="p-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 hover:text-slate-900 rounded-lg shadow-sm transition-colors cursor-pointer"
          title="Reset Layout"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
        <button
          onClick={() => setIsFullscreen(!isFullscreen)}
          className="p-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 hover:text-slate-900 rounded-lg shadow-sm transition-colors cursor-pointer"
          title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
        <button
          onClick={exportGraphJson}
          className="flex items-center gap-1.5 px-3 py-2 bg-blue-50 hover:bg-blue-100 text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg shadow-sm transition-all cursor-pointer font-semibold text-xs ml-2"
          title="Export Graph JSON"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export JSON</span>
        </button>
      </div>

      <div className="absolute top-4 right-4 z-10 bg-white/95 backdrop-blur px-3 py-1.5 border border-slate-200 rounded-lg shadow-sm text-[10px] font-mono text-slate-500 max-w-xs pointer-events-none hidden md:block">
        Drag nodes to reorganize. Click node to inspect details.
      </div>

      {/* Graph Canvas */}
      <div
        id="graph-container"
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseDown={handleContainerMouseDown}
        className="flex-1 w-full h-full relative overflow-hidden select-none cursor-grab active:cursor-grabbing"
      >
        <svg className="w-full h-full">
          {/* Arrow markers for directed lines */}
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="23"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#cbd5e1" />
            </marker>
            <marker
              id="arrow-hovered"
              viewBox="0 0 10 10"
              refX="23"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
            </marker>
          </defs>

          {/* Transform group for zooming and panning */}
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {/* Draw Links */}
            {links.map(link => {
              const sourceNode = nodes.find(n => n.id === link.source);
              const targetNode = nodes.find(n => n.id === link.target);

              if (!sourceNode || !targetNode) return null;

              const isLinkHovered =
                hoveredNodeId === link.source || hoveredNodeId === link.target;
              const isDimmed =
                hoveredNodeId !== null && !isLinkHovered;

              const midX = (sourceNode.x + targetNode.x) / 2;
              const midY = (sourceNode.y + targetNode.y) / 2;

              // Calculate text angle
              const angle = Math.atan2(targetNode.y - sourceNode.y, targetNode.x - sourceNode.x) * (180 / Math.PI);
              // Normalize angle so text is never upside down
              const normalizedAngle = angle > 90 || angle < -90 ? angle + 180 : angle;

              return (
                <g key={link.id} className="transition-opacity duration-200">
                  <line
                    x1={sourceNode.x}
                    y1={sourceNode.y}
                    x2={targetNode.x}
                    y2={targetNode.y}
                    stroke={isLinkHovered ? '#64748b' : '#e2e8f0'}
                    strokeWidth={isLinkHovered ? 2.5 : 1.5}
                    markerEnd={`url(#${isLinkHovered ? 'arrow-hovered' : 'arrow'})`}
                    opacity={isDimmed ? 0.2 : 1}
                  />
                  {/* Relation Label */}
                  <text
                    x={midX}
                    y={midY - 4}
                    transform={`rotate(${normalizedAngle}, ${midX}, ${midY})`}
                    textAnchor="middle"
                    fill={isLinkHovered ? '#475569' : '#94a3b8'}
                    className="font-mono font-medium select-none"
                    style={{ fontSize: '9px', pointerEvents: 'none' }}
                    opacity={isDimmed ? 0.15 : 1}
                  >
                    {link.type}
                  </text>
                </g>
              );
            })}

            {/* Draw Nodes */}
            {nodes.map(node => {
              const colorInfo = getNodeColor(node.type);
              const isNodeHighlighted =
                highlightedNodeIds === null || highlightedNodeIds.has(node.id);
              const isSelected = selectedEntityId === node.id;

              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  onMouseDown={(e) => handleMouseDown(node.id, e)}
                  onMouseEnter={() => setHoveredNodeId(node.id)}
                  onMouseLeave={() => setHoveredNodeId(null)}
                  onClick={() => onSelectEntity(node.id)}
                  className="cursor-pointer"
                  opacity={isNodeHighlighted ? 1 : 0.2}
                >
                  {/* Outer Pulsing Aura for Selected Node */}
                  {isSelected && (
                    <circle
                      r={30}
                      fill="none"
                      stroke={colorInfo.border}
                      strokeWidth={1.5}
                      className="animate-pulse"
                      opacity={0.4}
                    />
                  )}

                  {/* Node Capsule Shadow & Background */}
                  <rect
                    x={-60}
                    y={-18}
                    width={120}
                    height={36}
                    rx={18}
                    fill={colorInfo.bg}
                    stroke={isSelected ? colorInfo.border : '#ffffff'}
                    strokeWidth={isSelected ? 2.5 : 1.5}
                    style={{
                      filter: `drop-shadow(0 4px 6px ${colorInfo.shadow})`
                    }}
                  />

                  {/* Entity Type Label (Top Edge Small Tag) */}
                  <rect
                    x={-35}
                    y={-24}
                    width={70}
                    height={11}
                    rx={5}
                    fill={colorInfo.border}
                  />
                  <text
                    y={-16}
                    textAnchor="middle"
                    fill="#ffffff"
                    style={{ fontSize: '7px', fontWeight: 'bold' }}
                    className="tracking-wider uppercase font-sans select-none"
                  >
                    {node.type}
                  </text>

                  {/* Entity Name */}
                  <text
                    y={5}
                    textAnchor="middle"
                    fill={colorInfo.text}
                    style={{ fontSize: '10px', fontWeight: '600' }}
                    className="font-sans select-none truncate"
                  >
                    {node.name.length > 18 ? `${node.name.slice(0, 16)}...` : node.name}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* Selected Entity Context Drawer */}
      {activeSelectedNode && (
        <div className="absolute bottom-4 left-4 right-4 bg-white/95 backdrop-blur border border-slate-200 rounded-xl p-3.5 shadow-md flex items-start gap-3 z-10 transition-all duration-300">
          <div className="p-2 bg-slate-50 border border-slate-100 rounded-lg text-slate-500 shrink-0">
            <Info className="w-5 h-5 text-blue-500" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-sm font-semibold text-slate-800">{activeSelectedNode.name}</h4>
              <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-slate-100 text-slate-600">
                {activeSelectedNode.type}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {activeSelectedNode.description || 'No additional details provided in clinical notes.'}
            </p>
            {activeSelectedEntity?.umlsMapping?.cui && (
              <div className="mt-2.5 pt-2 border-t border-slate-100 flex flex-wrap gap-1 items-center">
                <span className="text-[8px] font-bold text-slate-400 uppercase tracking-wider mr-1.5 font-mono">UMLS Codes:</span>
                
                <a
                  href={`https://uts.nlm.nih.gov/uts/umls/concept/${activeSelectedEntity.umlsMapping.cui}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800 border border-slate-200 transition-colors"
                  title={`UMLS Concept Unique Identifier (CUI): ${activeSelectedEntity.umlsMapping.preferredName}`}
                  onClick={e => e.stopPropagation()}
                >
                  <span>CUI: {activeSelectedEntity.umlsMapping.cui}</span>
                </a>

                {activeSelectedEntity.umlsMapping.snomed && (
                  <a
                    href={`https://terminologie.nictiz.nl/art-decor/snomed-ct?conceptId=${activeSelectedEntity.umlsMapping.snomed}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 hover:bg-purple-100 hover:text-purple-900 border border-purple-100 transition-colors"
                    title="SNOMED-CT Code"
                    onClick={e => e.stopPropagation()}
                  >
                    <span>SNOMED: {activeSelectedEntity.umlsMapping.snomed}</span>
                  </a>
                )}

                {activeSelectedEntity.umlsMapping.rxnorm && (
                  <a
                    href={`https://mor.nlm.nih.gov/RxNav/search?searchBy=NameOrCode&searchTerm=${activeSelectedEntity.umlsMapping.rxnorm}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 hover:bg-sky-100 hover:text-sky-900 border border-sky-100 transition-colors"
                    title="RxNorm Code"
                    onClick={e => e.stopPropagation()}
                  >
                    <span>RxNorm: {activeSelectedEntity.umlsMapping.rxnorm}</span>
                  </a>
                )}

                {activeSelectedEntity.umlsMapping.icd10 && (
                  <a
                    href={`https://icd.who.int/browse10/2019/en#/${activeSelectedEntity.umlsMapping.icd10}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-900 border border-emerald-100 transition-colors"
                    title="ICD-10 Code"
                    onClick={e => e.stopPropagation()}
                  >
                    <span>ICD-10: {activeSelectedEntity.umlsMapping.icd10}</span>
                  </a>
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => onSelectEntity(null)}
            className="text-[10px] text-slate-400 hover:text-slate-600 font-medium cursor-pointer"
          >
            Clear Selection
          </button>
        </div>
      )}
    </div>
  );
}
