import * as nest from "nest";

@Controller("/")
export class AppController {
    @Get("/")
    index(c: Ptr<nest.Ctx>): [Any, Error | null] {
        return c.Render("index");
    }
}
