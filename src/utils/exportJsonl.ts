import { Entity, Mention, Relation, Conversation, ClinicalCategory } from '../types';

export type JsonlExportType = 'entities_mentions' | 'mentions' | 'full_dataset' | 'relations';

export function generateJsonlContent(
  type: JsonlExportType,
  session?: Partial<Conversation> | null,
  entities: Entity[] = [],
  mentions: Mention[] = [],
  relations: Relation[] = [],
  clinicalNotes?: ClinicalCategory
): string {
  const lines: string[] = [];

  if (type === 'entities_mentions') {
    // Each line is an entity enriched with its corresponding mentions
    entities.forEach(ent => {
      const entMentions = (mentions || []).filter(m => m.entityId === ent.id);
      const record = {
        id: ent.id,
        name: ent.name,
        type: ent.type,
        description: ent.description || '',
        textSpan: ent.textSpan || null,
        umlsMapping: ent.umlsMapping ? {
          cui: ent.umlsMapping.cui,
          preferredName: ent.umlsMapping.preferredName,
          rxnorm: ent.umlsMapping.rxnorm || null,
          snomed: ent.umlsMapping.snomed || null,
          icd10: ent.umlsMapping.icd10 || null,
          loinc: ent.umlsMapping.loinc || null,
        } : null,
        mentionsCount: entMentions.length,
        mentions: entMentions.map(m => ({
          id: m.id,
          textSpan: m.textSpan,
          speaker: m.speaker || null,
          polarity: m.polarity || 'positive',
          certainty: m.certainty || 'certain',
          temporality: m.temporality || 'current',
          experiencer: m.experiencer || 'patient',
          function: m.function || 'asserted',
          supportedAttribute: m.supportedAttribute || null
        }))
      };
      lines.push(JSON.stringify(record));
    });
  } else if (type === 'mentions') {
    // Each line is a distinct mention span with entity linkage
    (mentions || []).forEach(m => {
      const parentEntity = entities.find(e => e.id === m.entityId);
      const record = {
        id: m.id,
        entityId: m.entityId,
        entityName: parentEntity ? parentEntity.name : (m.textSpan?.text || ''),
        entityType: m.entityType || parentEntity?.type || 'Unknown',
        textSpan: m.textSpan,
        speaker: m.speaker || null,
        polarity: m.polarity || 'positive',
        certainty: m.certainty || 'certain',
        temporality: m.temporality || 'current',
        experiencer: m.experiencer || 'patient',
        function: m.function || 'asserted',
        supportedAttribute: m.supportedAttribute || null,
        umlsMapping: parentEntity?.umlsMapping ? {
          cui: parentEntity.umlsMapping.cui,
          preferredName: parentEntity.umlsMapping.preferredName,
          rxnorm: parentEntity.umlsMapping.rxnorm || null,
          snomed: parentEntity.umlsMapping.snomed || null,
          icd10: parentEntity.umlsMapping.icd10 || null,
          loinc: parentEntity.umlsMapping.loinc || null,
        } : null
      };
      lines.push(JSON.stringify(record));
    });
  } else if (type === 'relations') {
    // Each line is a relation edge
    (relations || []).forEach(r => {
      const sourceEnt = entities.find(e => e.id === r.source);
      const targetEnt = entities.find(e => e.id === r.target);
      const record = {
        id: r.id,
        relationType: r.type,
        sourceEntityId: r.source,
        sourceEntityName: sourceEnt ? sourceEnt.name : 'Unknown',
        sourceEntityType: sourceEnt ? sourceEnt.type : 'Unknown',
        targetEntityId: r.target,
        targetEntityName: targetEnt ? targetEnt.name : 'Unknown',
        targetEntityType: targetEnt ? targetEnt.type : 'Unknown',
      };
      lines.push(JSON.stringify(record));
    });
  } else if (type === 'full_dataset') {
    // Full document record
    const record = {
      sessionId: session?.id || 'session_export',
      title: session?.title || 'Clinical Encounter',
      encounterType: session?.encounterType || 'dialogue',
      createdAt: session?.createdAt || new Date().toISOString(),
      rawTranscript: session?.rawTranscript || '',
      transcriptSegments: session?.transcriptSegments || [],
      entities: entities,
      mentions: mentions || [],
      relations: relations || [],
      clinicalNotes: clinicalNotes || session?.annotation?.clinicalNotes || {}
    };
    lines.push(JSON.stringify(record));
  }

  return lines.join('\n');
}

export function downloadJsonlFile(content: string, filename: string) {
  const blob = new Blob([content], { type: 'application/x-jsonlines;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename.endsWith('.jsonl') ? filename : `${filename}.jsonl`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
