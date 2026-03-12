export namespace main {
	
	export class FileRecord {
	    name: string;
	    size: number;
	    mime_type: string;
	    created_at: string;
	    updated_at: string;
	    storage_path: string;
	    is_dir: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FileRecord(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.size = source["size"];
	        this.mime_type = source["mime_type"];
	        this.created_at = source["created_at"];
	        this.updated_at = source["updated_at"];
	        this.storage_path = source["storage_path"];
	        this.is_dir = source["is_dir"];
	    }
	}

}

