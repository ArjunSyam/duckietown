export namespace main {
	
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
	export class SearchResult {
	    file_name: string;
	    similarity: number;
	    snippet: string;
	    modality: string;
	    page: string;
	
	    static createFrom(source: any = {}) {
	        return new SearchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.file_name = source["file_name"];
	        this.similarity = source["similarity"];
	        this.snippet = source["snippet"];
	        this.modality = source["modality"];
	        this.page = source["page"];
	    }
	}

}

