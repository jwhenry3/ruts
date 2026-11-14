import * as nest from "nest";
import { AppController } from "./app.controller";
import { CoreModule } from "./core/core.module";
import { UsersModule } from "./users/users.module";

@Module({ imports: [CoreModule, UsersModule], controllers: [AppController] })
export class AppModule {}
