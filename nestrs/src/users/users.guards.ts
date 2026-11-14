import * as nest from "nest";
import { ConfigService } from "../core/config.service";

@Injectable()
export class AuthGuard {
    constructor(private config: ConfigService) {}

    canActivate(c: Ptr<nest.Ctx>): Bool {
        return c.Header("x-api-key") === this.config.get("API_KEY");
    }
}
