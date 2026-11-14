import * as nest from "nest";
import { UsersService } from "./users.service";
import { AuthGuard } from "./users.guards";
import { LoggingInterceptor } from "./users.interceptors";
import { CreateUserDto, UpdateUserDto } from "./dto/users.dto";

@Controller("/users")
@UseInterceptors(LoggingInterceptor)
export class UserController {
    constructor(private users: UsersService) {}

    @Get("/")
    findAll(c: Ptr<nest.Ctx>): [Any, Error | null] {
        return [this.users.findAll(), null];
    }

    @Get("/{id}")
    findOne(c: Ptr<nest.Ctx>): [Any, Error | null] {
        const [id, err] = c.ParamInt("id");
        if (err !== null) return [null, err];
        const [u, e2] = this.users.findOne(id);
        if (e2 !== null) return [null, e2];
        return [u, null];
    }

    @Post("/")
    create(c: Ptr<nest.Ctx>, body: CreateUserDto): [Any, Error | null] {
        return [this.users.create(body), null];
    }

    @Patch("/{id}")
    update(c: Ptr<nest.Ctx>, body: UpdateUserDto): [Any, Error | null] {
        const [id, err] = c.ParamInt("id");
        if (err !== null) return [null, err];
        const [u, e2] = this.users.update(id, body);
        if (e2 !== null) return [null, e2];
        return [u, null];
    }

    @Delete("/{id}")
    @UseGuards(AuthGuard)
    remove(c: Ptr<nest.Ctx>): [Any, Error | null] {
        const [id, err] = c.ParamInt("id");
        if (err !== null) return [null, err];
        return this.users.remove(id);
    }
}
