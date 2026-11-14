import * as nest from "nest";
import { ConfigService } from "./config.service";

@Module({ providers: [ConfigService], exports: [ConfigService] })
export class CoreModule {}
