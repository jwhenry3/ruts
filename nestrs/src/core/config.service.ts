import * as nest from "nest";

@Injectable()
export class ConfigService {
    get(key: Str): Str {
        if (key === "API_KEY") return "secret";
        return "";
    }
}
