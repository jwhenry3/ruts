import * as nest from "nest";
import { UserController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({ controllers: [UserController], providers: [UsersService], exports: [UsersService] })
export class UsersModule {}
