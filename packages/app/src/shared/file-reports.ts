import * as v from 'valibot';

export const fileReportReasonIds = [
	'copyright',
	'malware',
	'phishing',
	'leaked_data',
	'illegal_goods',
	'privacy',
	'impersonation',
	'defamation',
	'obscenity',
	'animal_abuse',
	'human_abuse',
] as const;

export const fileReportRelationshipIds = [
	'rights_holder',
	'agent',
	'third_party',
] as const;

export const fileReportStatusIds = [
	'open',
	'in_progress',
	'resolved',
	'junk',
] as const;

export const fileReportReasonSchema = v.nullable(v.picklist(fileReportReasonIds));
export const fileReportRelationshipSchema = v.nullable(v.picklist(fileReportRelationshipIds));
export const fileReportStatusSchema = v.picklist(fileReportStatusIds);

export type FileReportReasonId = typeof fileReportReasonIds[number];
export type FileReportRelationshipId = typeof fileReportRelationshipIds[number];
export type FileReportStatusId = typeof fileReportStatusIds[number];

export const fileReportReasonLabels: Record<FileReportReasonId, string> = {
	copyright: '著作権に抵触',
	malware: 'ウィルス、ランサムウェア等',
	phishing: 'フィッシング',
	leaked_data: '流出したデータ・情報',
	illegal_goods: '違法な物品・海賊版販売など',
	privacy: 'プライバシーの侵害',
	impersonation: 'なりすまし',
	defamation: '名誉毀損・侮辱',
	obscenity: '猥褻物',
	animal_abuse: '動物虐待',
	human_abuse: '暴力的な内容',
};

export const fileReportRelationshipLabels: Record<FileReportRelationshipId, string> = {
	rights_holder: '権利者本人',
	agent: '代理人',
	third_party: '第三者',
};

export const fileReportStatusLabels: Record<FileReportStatusId, string> = {
	open: '未対応',
	in_progress: '対応中',
	resolved: '解決済',
	junk: 'いたずら',
};
