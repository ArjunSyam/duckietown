export namespace agent {
	
	export class BackfillResult {
	    enriched: number;
	    skipped: number;
	    failed: number;
	
	    static createFrom(source: any = {}) {
	        return new BackfillResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enriched = source["enriched"];
	        this.skipped = source["skipped"];
	        this.failed = source["failed"];
	    }
	}
	export class ChatMessage {
	    role: string;
	    content: string;
	
	    static createFrom(source: any = {}) {
	        return new ChatMessage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.role = source["role"];
	        this.content = source["content"];
	    }
	}
	export class FailedMove {
	    file_name: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new FailedMove(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.file_name = source["file_name"];
	        this.error = source["error"];
	    }
	}
	export class RenamedFile {
	    original: string;
	    final: string;
	
	    static createFrom(source: any = {}) {
	        return new RenamedFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.original = source["original"];
	        this.final = source["final"];
	    }
	}
	export class ConfirmOrganiseResult {
	    folder_name: string;
	    files: string[];
	    created: boolean;
	    moved: string[];
	    renamed?: RenamedFile[];
	    failed?: FailedMove[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConfirmOrganiseResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.folder_name = source["folder_name"];
	        this.files = source["files"];
	        this.created = source["created"];
	        this.moved = source["moved"];
	        this.renamed = this.convertValues(source["renamed"], RenamedFile);
	        this.failed = this.convertValues(source["failed"], FailedMove);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RenameResultItem {
	    original: string;
	    final: string;
	
	    static createFrom(source: any = {}) {
	        return new RenameResultItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.original = source["original"];
	        this.final = source["final"];
	    }
	}
	export class ConfirmRenameResult {
	    renamed: RenameResultItem[];
	    failed?: FailedMove[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConfirmRenameResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.renamed = this.convertValues(source["renamed"], RenameResultItem);
	        this.failed = this.convertValues(source["failed"], FailedMove);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class OrganiseFolderResult {
	    folder_name: string;
	    files: string[];
	    created: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new OrganiseFolderResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.folder_name = source["folder_name"];
	        this.files = source["files"];
	        this.created = source["created"];
	        this.error = source["error"];
	    }
	}
	export class OrganiseIntent {
	    is_organise: boolean;
	    query: string;
	    folder_name: string;
	    type_filter: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new OrganiseIntent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.is_organise = source["is_organise"];
	        this.query = source["query"];
	        this.folder_name = source["folder_name"];
	        this.type_filter = source["type_filter"];
	        this.error = source["error"];
	    }
	}
	export class ProposedGrouping {
	    folder_name: string;
	    description: string;
	
	    static createFrom(source: any = {}) {
	        return new ProposedGrouping(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.folder_name = source["folder_name"];
	        this.description = source["description"];
	    }
	}
	export class PlannedMove {
	    file_name: string;
	    from_folder: string;
	    to_folder: string;
	    reason: string;
	
	    static createFrom(source: any = {}) {
	        return new PlannedMove(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.file_name = source["file_name"];
	        this.from_folder = source["from_folder"];
	        this.to_folder = source["to_folder"];
	        this.reason = source["reason"];
	    }
	}
	export class OrganisePreview {
	    plan_id?: string;
	    target_folder?: string;
	    moves?: PlannedMove[];
	    needs_clarification: boolean;
	    proposed_groupings?: ProposedGrouping[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new OrganisePreview(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.plan_id = source["plan_id"];
	        this.target_folder = source["target_folder"];
	        this.moves = this.convertValues(source["moves"], PlannedMove);
	        this.needs_clarification = source["needs_clarification"];
	        this.proposed_groupings = this.convertValues(source["proposed_groupings"], ProposedGrouping);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	export class RenameSelection {
	    file_name: string;
	    include: boolean;
	    edited_new_name?: string;
	
	    static createFrom(source: any = {}) {
	        return new RenameSelection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.file_name = source["file_name"];
	        this.include = source["include"];
	        this.edited_new_name = source["edited_new_name"];
	    }
	}
	
	export class SearchResult {
	    file_name: string;
	    similarity: number;
	    score?: number;
	    snippet: string;
	    modality: string;
	    page: string;
	    folder_path?: string;
	    mime_type?: string;
	    summary?: string;
	    category?: string;
	
	    static createFrom(source: any = {}) {
	        return new SearchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.file_name = source["file_name"];
	        this.similarity = source["similarity"];
	        this.score = source["score"];
	        this.snippet = source["snippet"];
	        this.modality = source["modality"];
	        this.page = source["page"];
	        this.folder_path = source["folder_path"];
	        this.mime_type = source["mime_type"];
	        this.summary = source["summary"];
	        this.category = source["category"];
	    }
	}

}

export namespace supabase {
	
	export class FileRecord {
	    id: string;
	    name: string;
	    size: number;
	    mime_type: string;
	    folder_path: string;
	    created_at: string;
	    updated_at: string;
	    storage_path: string;
	
	    static createFrom(source: any = {}) {
	        return new FileRecord(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.size = source["size"];
	        this.mime_type = source["mime_type"];
	        this.folder_path = source["folder_path"];
	        this.created_at = source["created_at"];
	        this.updated_at = source["updated_at"];
	        this.storage_path = source["storage_path"];
	    }
	}

}

export namespace vault {
	
	export class FolderRecord {
	    path: string;
	    name: string;
	    parent: string;
	    children: number;
	
	    static createFrom(source: any = {}) {
	        return new FolderRecord(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.parent = source["parent"];
	        this.children = source["children"];
	    }
	}

}

